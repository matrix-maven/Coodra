<!--
Thanks for the PR. Fill in the sections below — they speed up review. Delete the parts that don't apply.
-->

## Summary

<!-- One or two sentences on what this PR changes and why. -->

## How to verify

<!-- Concrete steps a reviewer can run on their machine to see the change. -->

```bash
# example
pnpm install
pnpm typecheck
pnpm test:unit
```

## Done checklist

- [ ] `pnpm typecheck` passes
- [ ] `pnpm test:unit` passes
- [ ] `pnpm lint` passes (or formatting drift is auto-fixed via `pnpm lint:fix`)
- [ ] If touching a service boundary or migration: `pnpm test:integration` passes locally
- [ ] If touching agent-facing surfaces (MCP tool, CLI command, hook payload): user-visible doc updated in the same PR
- [ ] If schema change: new Drizzle migration (no edits to published migrations); SQLite + Postgres dialects updated together
- [ ] No `any`, no shallow stubs, no `// TODO`s in committed code

## Related

<!-- Issues, ADRs, or context packs this PR closes / implements / references. -->

Closes #
