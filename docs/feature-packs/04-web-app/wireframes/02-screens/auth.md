# `/auth/sign-in` and `/auth/sign-up` — Auth surfaces (S10, team only)

Solo mode returns 404 on these routes per OQ-3 lock. Team mode renders Clerk-hosted pages with `appearance` prop tuned to brand tokens.

## Sign-in — desktop

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                         │
│                              [CTX]OS                                                    │
│                              ^^^^^^^                                                    │
│                              --font-display weight 900 text-5xl (40/48)                 │
│                                                                                         │
│                              Sign in to continue                                        │
│                              --font-display 300 uppercase letterspacing 0.04em          │
│                              --color-text-secondary                                     │
│                                                                                         │
│                                                                                         │
│            ┌─────────────────────────────────────────────────────────────┐              │
│            │                                                             │              │
│            │  ┌───────────────────────────────────────────────────────┐  │              │
│            │  │ [G] CONTINUE WITH GOOGLE                              │  │              │
│            │  └───────────────────────────────────────────────────────┘  │              │
│            │                                                             │              │
│            │  ┌───────────────────────────────────────────────────────┐  │              │
│            │  │ [GH] CONTINUE WITH GITHUB                             │  │              │
│            │  └───────────────────────────────────────────────────────┘  │              │
│            │                                                             │              │
│            │  ─────────────────────  OR  ─────────────────────────       │              │
│            │                                                             │              │
│            │  Email address                                              │              │
│            │  [                                                       ]  │              │
│            │                                                             │              │
│            │  Password                                                   │              │
│            │  [                                                       ]  │              │
│            │                                                             │              │
│            │  ┌──────────────────────────────────────────────────────┐   │              │
│            │  │  CONTINUE                                            │   │              │
│            │  └──────────────────────────────────────────────────────┘   │              │
│            │                                                             │              │
│            │  Don't have an account? Sign up                             │              │
│            │                                                             │              │
│            └─────────────────────────────────────────────────────────────┘              │
│                                                                                         │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

## Clerk `appearance` prop

```ts
// apps/web/app/auth/sign-in/page.tsx
<SignIn
  appearance={{
    variables: {
      colorPrimary: 'var(--color-brand)',
      colorBackground: 'var(--color-bg-base)',
      colorText: 'var(--color-text-primary)',
      colorTextSecondary: 'var(--color-text-secondary)',
      colorInputBackground: 'var(--color-bg-surface)',
      colorInputText: 'var(--color-text-primary)',
      colorDanger: 'var(--color-status-error)',
      colorSuccess: 'var(--color-status-success)',
      fontFamily: 'var(--font-display)',
      fontFamilyButtons: 'var(--font-display)',
      borderRadius: '0',  // brand-mandatory zero-radius
      spacingUnit: '8px',
    },
    elements: {
      formButtonPrimary: 'uppercase tracking-wider font-bold',
      socialButtonsBlockButton: 'uppercase tracking-wider font-bold',
      formFieldLabel: 'uppercase tracking-wider font-bold text-xs',
      headerTitle: 'font-display font-black uppercase',
    },
  }}
/>
```

The `borderRadius: '0'` is the most important override — Clerk's default rounded corners would visibly conflict with the brand's zero-radius mandate. The `appearance.elements` overrides apply Tailwind utilities to specific Clerk-provided components for typography fidelity.

## Sign-up — desktop

Same shape, "Sign in" → "Sign up", "Continue" → "Create account", "Don't have…" → "Already have an account? Sign in". Adds optional fields per Clerk config (we keep it minimal: email + password + Google/GitHub).

## Mobile

Same layout, full-width card, max-width 360px. Vertical stacking.

## Token annotations

(Per the Clerk `variables` block; the appearance prop is the single source of truth for the auth surface's tokens.)

## Solo mode

Both routes return 404 from `apps/web/middleware.ts`. The 404 page is the brand's standard 404:

```
                                404
                                ───

                            Not found
                            in solo mode.

                            ◂ Return to dashboard
```

(404 page is shipped in S1 as part of the route shell; not detailed here.)
