# Security Policy

## Reporting A Vulnerability

If you believe you have found a security issue in Coodra, please report it
privately.

Email: **info@matrixmaven.co**

Please include:

- A clear description of the issue and expected impact.
- Steps to reproduce, or a proof of concept.
- The Coodra CLI version from `coodra --version`.
- Your operating system and Node.js version.
- Whether the issue affects solo mode, team mode, or both.
- Whether you have already disclosed the issue to anyone else.

We will acknowledge your report within 72 hours and aim to provide an initial
assessment and remediation timeline within 7 days.

Please do not open a public GitHub issue, post about the vulnerability publicly,
or share exploit details with third parties until we have published a fix or
coordinated disclosure with you.

## Supported Versions

Security fixes target the latest published `@coodra/cli` release and `main` on
GitHub. Older releases are not back-patched unless Matrix Maven explicitly says
otherwise for a specific incident.

| Version | Supported |
|---|---|
| Latest `@coodra/cli` release | yes |
| `main` | yes |
| Older releases | no - please upgrade |

## In Scope

- `@coodra/cli`, including install, init, agent wiring, start/stop, update, and
  generated-file management.
- The Coodra MCP server, including all MCP tools and lifecycle-event handling.
- Native plugin wiring for supported coding agents.
- Policy evaluation, policy audit records, and kill/pause controls.
- Local SQLite storage, migrations, and team-mode sync behavior.
- The sync daemon and Postgres mirror paths used for team mode.
- The local or self-hosted web dashboard in `apps/web-v2`.
- Coodra-managed Graphify MCP wiring and access to project graph artifacts.
- Package publishing, bundled runtime layout, and upgrade behavior.

## Out Of Scope

- Vulnerabilities in third-party services or providers, including identity,
  database hosting, Jira, Linear, GitHub, or model providers. Please report
  those to the provider directly.
- Vulnerabilities in upstream Graphify itself, unless the issue is caused by
  Coodra's packaging, wiring, or invocation.
- User-authored Recipes, Context Packs, Work Packs, wiki pages, or policy rules,
  unless Coodra mishandles them in a way that creates a product vulnerability.
- Denial of service against a user's own local machine that does not cross a
  trust boundary or expose data.

## Research Guidelines

- Use your own projects, test data, and accounts.
- Do not access, modify, or exfiltrate data that does not belong to you.
- Do not attempt persistence, lateral movement, or destructive actions.
- Stop testing and report privately once you have enough evidence to demonstrate
  the issue.

## Credit

We will credit reporters in release notes unless they prefer to remain
anonymous. Coodra does not currently run a paid bug bounty program.

We will not pursue legal action against good-faith security research that
follows this policy.
