# `/settings/team` and `/settings/account` — Settings (S10, team only)

Solo mode returns 404. Team mode embeds Clerk's `<OrganizationProfile>` and `<UserProfile>` components, both styled via the `appearance` prop set in `auth.md`.

## `/settings/team` — desktop

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│  settings / team                                                                        │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                         │
│  TEAM SETTINGS                                                                          │
│                                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐    │
│  │                                                                                 │    │
│  │  <OrganizationProfile> embedded here, full Clerk component:                     │    │
│  │   - General (org name, slug, logo)                                              │    │
│  │   - Members (list, role per member, invite, remove)                             │    │
│  │   - Invitations (pending, role per pending)                                     │    │
│  │   - Domains (auto-invite)                                                       │    │
│  │   - Danger zone (leave, delete)                                                 │    │
│  │                                                                                 │    │
│  │  All sub-tabs styled via Clerk appearance prop (zero-radius, brand colors,      │    │
│  │  Inter typography, JetBrains Mono for member emails).                           │    │
│  │                                                                                 │    │
│  └─────────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                         │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

## `/settings/account` — desktop

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│  settings / account                                                                     │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                         │
│  ACCOUNT                                                                                │
│                                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐    │
│  │                                                                                 │    │
│  │  <UserProfile> embedded — Clerk component covers:                               │    │
│  │   - Account (name, email, avatar)                                               │    │
│  │   - Security (password, MFA, sessions)                                          │    │
│  │   - Connected accounts (Google, GitHub)                                         │    │
│  │   - Danger zone (delete)                                                        │    │
│  │                                                                                 │    │
│  └─────────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                         │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

## Coodra-specific settings (DEFERRED to a follow-up module)

M04 does NOT add a "Settings → Coodra" section. Items that would live there (default polling cadence override, dashboard tile customisation, kill-switch propagation timeout, telemetry opt-in) are out of scope for v1. M07 VS Code extension might surface a parallel settings panel for the in-IDE experience.

## Solo mode

Both routes 404 (per OQ-3 + spec §9). The "Solo mode" badge in the header chrome is the only "settings" affordance solo users see — and it's read-only.

## Mobile

Clerk components are responsive by default. Token overrides via `appearance.variables` carry through to mobile.

## Why no custom team-management UI

Building our own org-management UI when Clerk ships one is duplication. The brand prop tuning is light enough (zero-radius + tokens + Inter) to make Clerk's components feel native to Coodra without the cost of authoring a parallel surface that does the same job.

If/when we have Coodra-specific team-level config (e.g. "default org-wide kill-switch propagation policy"), that gets a new section sibling to `/settings/team`, not a fork of it.
