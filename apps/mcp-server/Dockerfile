# syntax=docker/dockerfile:1.7
#
# Multi-stage build for @coodra/mcp-server.
#
# Stage 1 (deps):    resolve and install the full pnpm workspace, including
#                    dev deps, so TypeScript can compile against the same
#                    graph CI uses.
# Stage 2 (build):   tsc the workspace packages @coodra/mcp-server
#                    depends on (shared + db + mcp-server itself).
# Stage 3 (deploy):  use `pnpm deploy` to carve out a minimal, self-contained
#                    deploy directory containing ONLY @coodra/mcp-server
#                    and its production deps (no workspace symlinks, no dev
#                    deps, no test files). This is what pnpm's `deploy`
#                    command is designed for — see
#                    https://pnpm.io/cli/deploy.
# Stage 4 (runtime): copy the deploy directory onto a fresh, slim Node
#                    base image. No build tools, no source, no tests.
#
# Base image pin:
# We use `node:22.16.0-bookworm-slim` (Debian-based, glibc) pinned by the
# multi-arch index digest returned by `docker inspect`. This version
# matches `.nvmrc` so local dev, CI, and container builds share one
# Node version.
#
# Alpine is deliberately avoided: musl breaks `better-sqlite3` and
# `sqlite-vec`'s prebuilt binaries, both of which are linked against
# glibc. Running them on musl would force a source rebuild (adding
# build-essential + python to the runtime image) and lose the pin on
# the binary — a net regression on both size and supply-chain control.
#
# The digest was resolved on 2026-04-23 via:
#   docker pull node:22.16.0-bookworm-slim
#   docker inspect --format='{{index .RepoDigests 0}}' node:22.16.0-bookworm-slim
# It is safe to re-pin to a newer digest; just update the two `FROM`
# lines together and rerun the pull + inspect commands.

# ──────────────────────────────────────────────────────────────────────
# Stage 1 — deps: full workspace install
# ──────────────────────────────────────────────────────────────────────
FROM node@sha256:048ed02c5fd52e86fda6fbd2f6a76cf0d4492fd6c6fee9e2c463ed5108da0e34 AS deps

ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV CI=1

# Enable corepack so the exact pnpm pinned in root package.json is used.
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /repo

# Copy workspace manifests first so the dependency graph is cached
# independent of source-file changes.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY .nvmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/mcp-server/package.json apps/mcp-server/

# Install the ENTIRE workspace (including dev deps) so typecheck + build
# work. pnpm fetches and links all packages but only the stages below
# consume the parts they need.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ──────────────────────────────────────────────────────────────────────
# Stage 2 — build: compile shared + db + mcp-server
# ──────────────────────────────────────────────────────────────────────
FROM deps AS build

WORKDIR /repo

# Bring in source. .dockerignore keeps __tests__/ + dist/ + node_modules/
# out of the context, so this COPY is tight.
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/db ./packages/db
COPY apps/mcp-server ./apps/mcp-server

# Build in dependency order. Turbo handles this when invoked from root,
# but we call the scripts directly here so the Dockerfile does not
# depend on .turbo cache state.
RUN pnpm --filter @coodra/shared build \
 && pnpm --filter @coodra/db build \
 && pnpm --filter @coodra/mcp-server build

# ──────────────────────────────────────────────────────────────────────
# Stage 3 — deploy: `pnpm deploy` carves out a production-only tree
# ──────────────────────────────────────────────────────────────────────
FROM build AS deploy

WORKDIR /repo

# `pnpm deploy` copies the target workspace (mcp-server) plus its
# transitive production-only deps into a new directory with no
# symlinks or workspace:* rewrites. The output is ready to run with
# a bare `node dist/index.js`.
RUN pnpm --filter @coodra/mcp-server deploy --prod --legacy /out

# ──────────────────────────────────────────────────────────────────────
# Stage 4 — runtime: minimal production image
# ──────────────────────────────────────────────────────────────────────
FROM node@sha256:048ed02c5fd52e86fda6fbd2f6a76cf0d4492fd6c6fee9e2c463ed5108da0e34 AS runtime

# Non-root user. `node` (UID 1000) ships with the Node base images.
USER node
WORKDIR /app

# Production-only env. COODRA_LOG_DESTINATION=stderr is load-bearing:
# the stdio MCP transport uses stdout exclusively for JSON-RPC frames
# and any log byte on stdout corrupts it. The bootstrap module in src/
# enforces this too, but setting it here is defence-in-depth.
ENV NODE_ENV=production
ENV COODRA_LOG_DESTINATION=stderr
ENV COODRA_MODE=solo

# Copy the pnpm deploy output. It includes dist/ + the flattened
# node_modules/ tree + package.json. Nothing else from the build
# stage comes along — no source, no tests, no tsconfigs.
COPY --from=deploy --chown=node:node /out /app

# No EXPOSE: the stdio transport does not bind a port. S16 adds the
# HTTP transport and this Dockerfile will grow an EXPOSE 3100 then.

# Use the built JS entrypoint directly; `node` handles signals
# correctly for our graceful-shutdown hooks in src/index.ts.
CMD ["node", "dist/index.js"]
