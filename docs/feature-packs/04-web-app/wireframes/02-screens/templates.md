# `/templates` — Template browser (S7)

CLI parity: `coodra template {list, install}`.

## Desktop

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│  templates                                                                              │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                         │
│  TEMPLATES                                                                              │
│  Bundled and user-installed feature-pack templates.                                     │
│                                                                                         │
│  Filter: [ All ▾ ] (Bundled / User / All)                  ┌──────────────────────────┐  │
│                                                            │  INSTALL FROM PATH ▸     │  │
│                                                            └──────────────────────────┘  │
│                                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐    │
│  │  generic                                              [bundled]   v1.0.0        │    │
│  │  Always-applicable fallback. Use when no language-specific template matches.    │    │
│  │  languages: —                                                                   │    │
│  │  @auto sections: overview, directory-structure, scripts, entry-points           │    │
│  │  /Users/abishaikc/Coodra/packages/cli/templates/generic                         │    │
│  ├─────────────────────────────────────────────────────────────────────────────────┤    │
│  │  go-service                                           [bundled]   v1.0.0        │    │
│  │  Go HTTP service — net/http + slog + clean-architecture layout under cmd/ +     │    │
│  │  internal/.                                                                     │    │
│  │  languages: go                                                                  │    │
│  │  @auto sections: overview, directory-structure, scripts, entry-points,          │    │
│  │                  dependencies                                                   │    │
│  │  /Users/abishaikc/Coodra/packages/cli/templates/go-service                      │    │
│  ├─────────────────────────────────────────────────────────────────────────────────┤    │
│  │  ... (5 more bundled)                                                           │    │
│  ├─────────────────────────────────────────────────────────────────────────────────┤    │
│  │  verify-custom                                        [user]     v1.0.0        │    │
│  │  M08b verification template                                                     │    │
│  │  languages: javascript                                                          │    │
│  │  @auto sections: overview                                                       │    │
│  │  ~/.coodra/templates/verify-custom                                           │    │
│  └─────────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                         │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

## Token annotations

| Surface | Tokens |
|---|---|
| Template name | `--font-mono` weight 500 text-xl |
| `[bundled]` / `[user]` chip | `<StatusChip status="info">bundled</StatusChip>`, `<StatusChip status="neutral">user</StatusChip>` |
| Version | `--font-mono` text-sm `--color-text-tertiary` |
| Description | `--font-sans` 400 text-sm `--color-text-secondary` |
| `languages:` and `@auto sections:` rows | label `--font-display` weight 700 text-xs uppercase, value `--font-mono` text-sm |
| Path | `--font-mono` weight 400 text-xs `--color-text-tertiary` |
| Card spacing | each card `--space-6` padding, separated by 1px `--color-border-subtle` |

## INSTALL FROM PATH dialog

Click → dialog opens (full-screen on mobile, centered modal on desktop):

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ✕  INSTALL TEMPLATE                                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Path to template directory:                                            │
│  [ /Users/abishaikc/my-template                                       ] │
│  Must contain template.json + spec.md.tmpl + implementation.md.tmpl +   │
│  techstack.md.tmpl + meta.json.tmpl.                                    │
│                                                                         │
│  Install as (override name):                                            │
│  [ my-template                                                        ] │
│  Optional. Defaults to template.json#name.                              │
│                                                                         │
│  ☐ Force overwrite if already installed at this name                    │
│                                                                         │
│                                                       ┌─────────────┐   │
│                                                       │  INSTALL    │   │
│                                                       └─────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

- Server action calls `installTemplate` (M08b S17 helper).
- Validation errors (missing files, invalid template.json schema) appear inline below the path input as `<ErrorBanner severity="error">`.
- On success: dialog dismisses, toast "Installed 'my-template' at ~/.coodra/templates/my-template", new card appears in the list.

## Mobile

Cards stack full-width. INSTALL FROM PATH button moves below the filter row.

## Solo vs team

Templates are per-machine (under `~/.coodra/templates/`), not synced. Solo and team see the same template list — they're not org-scoped.
