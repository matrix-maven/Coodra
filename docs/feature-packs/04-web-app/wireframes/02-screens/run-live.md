# `/runs/[id]/live` — Live run view (S4)

Same shape as `/runs/[id]` (read `run-detail.md` first) with three differences:

1. The polling adapter (`apps/web/lib/poll.ts`) hits `/api/runs/[id]/state` every 1500ms. New events / decisions / policy decisions land in their tabs in-place.
2. The header shows a `STREAMING` indicator.
3. When the run's status flips to `cancelled` / `completed` / `failed`, the page auto-routes to the static `/runs/[id]`.

## Header diff

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│  run_verify_1777830445                                          [in_progress]           │
│                                                                                         │
│  Project: verify-m08b   ·   Agent: claude_code (solo)   ·   Session: sess-…45           │
│                                                                                         │
│  Started:  17:47:25       (running for 1m 24s)                                          │
│                                                                                         │
│                                                            ╭────────────────╮           │
│                                                            │  ●  STREAMING  │           │
│                                                            ╰────────────────╯           │
│                                                              ^                          │
│                                                              Precision Blue dot,        │
│                                                              animated 1.5s pulse        │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

- `STREAMING` chip uses `<StatusChip status="info">`.
- The leading `●` is animated: opacity oscillates 0.4 ↔ 1.0 with a 1.5s sine-easing loop. This is the only animated element in the entire app — operators need to know the page is alive when nothing is happening.
- "running for 1m 24s" is computed client-side and updates each second (separate from the polling clock — pure client tick).

## Polling visibility

A small caption below the header chrome:

```
Last updated 0.7s ago                                          [PAUSE POLLING]
^^^^^^^^^^^^^^^^^^^^^                                           ^^^^^^^^^^^^^^^
--font-mono text-xs                                             secondary button,
--color-text-tertiary                                           --space-8 height,
                                                                Inter 700, uppercase
```

- Caption is updated on every polling tick.
- "PAUSE POLLING" button toggles to "RESUME POLLING" when paused. Useful for operators who want a stable view to screenshot.
- When the tab is hidden, the caption switches to `Paused (tab hidden)`. On unhide, it resumes immediately.
- On network error: caption switches to `Reconnecting in 3s…` (counts down) and the polling adapter applies its exponential backoff (per spec §8). After max-retries (5 attempts → 30s), caption becomes `Disconnected — refresh to retry` and the user must reload.

## In-place tab updates

When new data arrives:

- Events tab: new row slides up in 320ms (`--motion-route`, ease-out). Tab badge count increments without animation.
- Decisions tab: same slide-up.
- Audit tab: same slide-up.
- Active tab is visible to the user; non-active tabs only update their badge counts. When the user clicks an updated tab, no animation runs (the new rows are already there).

## Auto-redirect on terminal

When `status` flips to a terminal value, the polling adapter calls `router.replace('/runs/[id]')` (no slide animation; the URL just changes). The static `/runs/[id]` page is rendered fresh server-side.

The redirect carries the active-tab hash forward: `/runs/[id]/live#audit` → `/runs/[id]#audit`.

## Visual difference from `/runs/[id]`

Apart from the header indicator + "Last updated" caption, the page is structurally identical to the static run detail. Same tab strip, same components. The only client-side difference is the polling hook — server-rendered HTML is identical. This means the same screenshot test can verify both surfaces' geometry; only the streaming chrome differs.

## Mobile

Same as run-detail.md mobile layout. The streaming chip moves below the header into the breadcrumb track (the right edge of the breadcrumb gets the chip).

## Failure modes

| State | UI |
|---|---|
| First-load fails (run not found) | Page-level 404, "Return to runs" link |
| Run terminates while user is viewing | Auto-redirect (no flicker) |
| Polling fails, retries succeed | Caption shows reconnect countdown, clears on success |
| Polling fails 5×, gives up | Caption: "Disconnected — refresh to retry"; tabs frozen at last known state |
| Server returns 304 | No animation, no caption change beyond timestamp |
| Run was cancelled by another user (team) | Banner appears: "This run was cancelled by alice@org at 17:48:33." Page auto-redirects to `/runs/[id]` after 3s. |
