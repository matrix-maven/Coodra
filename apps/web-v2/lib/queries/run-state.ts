import type { RunWithEverything } from '@coodra/contextos-db';

/**
 * Computes the wall-clock high-water-mark for a run's state — the
 * latest createdAt across runs.startedAt/endedAt + run_events +
 * decisions + policy_decisions + context_packs. Used by the
 * `/api/runs/[id]/state` route handler to set the `Last-Modified`
 * header so polling clients can short-circuit unchanged ticks via
 * `If-Modified-Since`.
 *
 * Returns a Date (always defined — runs.startedAt is non-null per
 * schema). Caller converts to RFC 7231 via `.toUTCString()`.
 */
export function runStateLastModified(snapshot: RunWithEverything): Date {
  let latest = snapshot.run.startedAt.getTime();
  if (snapshot.run.endedAt !== null) {
    latest = Math.max(latest, snapshot.run.endedAt.getTime());
  }
  for (const evt of snapshot.events) {
    latest = Math.max(latest, evt.createdAt.getTime());
  }
  for (const dec of snapshot.decisions) {
    latest = Math.max(latest, dec.createdAt.getTime());
  }
  for (const pd of snapshot.policyDecisions) {
    latest = Math.max(latest, pd.createdAt.getTime());
  }
  if (snapshot.contextPack !== null) {
    latest = Math.max(latest, snapshot.contextPack.createdAt.getTime());
  }
  return new Date(latest);
}

/**
 * Serializes a run snapshot for the polling endpoint. Dates → ISO
 * strings; nulls preserved; nothing dropped. Mirrors `contextos export
 * --format json` shape (M08b S12) so consumers can switch between the
 * CLI and the web endpoint without re-shaping.
 */
export function serializeRunState(snapshot: RunWithEverything): SerializedRunState {
  return {
    run: {
      ...snapshot.run,
      startedAt: snapshot.run.startedAt.toISOString(),
      endedAt: snapshot.run.endedAt === null ? null : snapshot.run.endedAt.toISOString(),
    },
    events: snapshot.events.map((evt) => ({
      ...evt,
      createdAt: evt.createdAt.toISOString(),
    })),
    decisions: snapshot.decisions.map((dec) => ({
      ...dec,
      createdAt: dec.createdAt.toISOString(),
    })),
    policyDecisions: snapshot.policyDecisions.map((pd) => ({
      ...pd,
      createdAt: pd.createdAt.toISOString(),
    })),
    contextPack:
      snapshot.contextPack === null
        ? null
        : { ...snapshot.contextPack, createdAt: snapshot.contextPack.createdAt.toISOString() },
  };
}

export interface SerializedRunState {
  readonly run: Omit<RunWithEverything['run'], 'startedAt' | 'endedAt'> & {
    readonly startedAt: string;
    readonly endedAt: string | null;
  };
  readonly events: ReadonlyArray<
    Omit<RunWithEverything['events'][number], 'createdAt'> & { readonly createdAt: string }
  >;
  readonly decisions: ReadonlyArray<
    Omit<RunWithEverything['decisions'][number], 'createdAt'> & { readonly createdAt: string }
  >;
  readonly policyDecisions: ReadonlyArray<
    Omit<RunWithEverything['policyDecisions'][number], 'createdAt'> & { readonly createdAt: string }
  >;
  readonly contextPack:
    | (Omit<NonNullable<RunWithEverything['contextPack']>, 'createdAt'> & { readonly createdAt: string })
    | null;
}
