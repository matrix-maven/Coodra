'use client';

/**
 * `apps/web/lib/poll.ts` — client-side polling adapter per spec §8 + OQ-2 lock.
 *
 * Usage:
 *
 *   const { data, error, isLoading, lastModified } = usePoll<RunState>({
 *     url: `/api/runs/${id}/state`,
 *     intervalMs: 1500,
 *     pauseWhenHidden: true,
 *     initialData: serverRendered,
 *   });
 *
 * Behaviour:
 *   - Interval-based GET; `If-Modified-Since` round-trips so 304 short-
 *     circuits when state hasn't changed.
 *   - Pauses when `document.hidden === true` (Page Visibility API).
 *     Resumes immediately on tab unhide.
 *   - Exponential backoff on transport error: 1.5s → 3s → 6s → 12s → 30s
 *     (cap). Resets to baseline on next success.
 *   - Aborts in-flight requests when the component unmounts.
 *   - `initialData` lets the caller seed from a server-rendered snapshot
 *     so the first tick doesn't flash an empty state.
 *
 * Server contract:
 *   - 200 OK + JSON body + Last-Modified header → fresh state
 *   - 304 Not Modified (no body) → keep current `data`
 *   - non-2xx / network error → backoff, surface `error`
 */

import { useEffect, useRef, useState } from 'react';

const BACKOFF_LADDER_MS = [1500, 3000, 6000, 12000, 30000] as const;

export interface PollOptions<T> {
  readonly url: string;
  readonly intervalMs?: number;
  readonly pauseWhenHidden?: boolean;
  readonly initialData?: T;
  readonly initialLastModified?: string;
}

export interface PollResult<T> {
  readonly data: T | undefined;
  readonly error: Error | undefined;
  readonly isLoading: boolean;
  readonly lastModified: string | undefined;
  /** True when polling is paused due to tab hidden. */
  readonly isPaused: boolean;
  /** ms until next attempt; useful for "Reconnecting in 3s…" captions. */
  readonly nextAttemptInMs: number | undefined;
}

export function usePoll<T>(opts: PollOptions<T>): PollResult<T> {
  const intervalMs = opts.intervalMs ?? 1500;
  const pauseWhenHidden = opts.pauseWhenHidden ?? true;

  const [data, setData] = useState<T | undefined>(opts.initialData);
  const [error, setError] = useState<Error | undefined>();
  const [isLoading, setIsLoading] = useState<boolean>(opts.initialData === undefined);
  const [lastModified, setLastModified] = useState<string | undefined>(opts.initialLastModified);
  const [isPaused, setIsPaused] = useState<boolean>(
    typeof document !== 'undefined' && pauseWhenHidden ? document.hidden : false,
  );
  const [nextAttemptInMs, setNextAttemptInMs] = useState<number | undefined>();

  const backoffStepRef = useRef<number>(-1); // -1 = baseline
  const lastModifiedRef = useRef<string | undefined>(opts.initialLastModified);
  const isMountedRef = useRef<boolean>(true);
  const inFlightAbortRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    lastModifiedRef.current = lastModified;
  }, [lastModified]);

  // Page Visibility wiring.
  useEffect(() => {
    if (!pauseWhenHidden || typeof document === 'undefined') return;
    const onVis = () => setIsPaused(document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [pauseWhenHidden]);

  // Polling loop.
  useEffect(() => {
    isMountedRef.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      if (!isMountedRef.current) return;
      if (isPaused) {
        // Park; visibility change effect will re-trigger via the
        // dep on `isPaused`.
        return;
      }
      const ac = new AbortController();
      inFlightAbortRef.current = ac;
      try {
        const headers: Record<string, string> = {};
        if (lastModifiedRef.current !== undefined) {
          headers['If-Modified-Since'] = lastModifiedRef.current;
        }
        const res = await fetch(opts.url, { headers, signal: ac.signal });
        if (!isMountedRef.current) return;
        if (res.status === 304) {
          backoffStepRef.current = -1;
          setError(undefined);
          setIsLoading(false);
        } else if (res.ok) {
          const body = (await res.json()) as T;
          backoffStepRef.current = -1;
          setData(body);
          setError(undefined);
          setIsLoading(false);
          const lm = res.headers.get('Last-Modified');
          if (lm !== null) setLastModified(lm);
        } else {
          throw new Error(`poll: HTTP ${res.status}`);
        }
      } catch (err) {
        if (!isMountedRef.current) return;
        if ((err as { name?: string }).name === 'AbortError') return;
        backoffStepRef.current = Math.min(backoffStepRef.current + 1, BACKOFF_LADDER_MS.length - 1);
        setError(err instanceof Error ? err : new Error(String(err)));
        setIsLoading(false);
      }

      if (!isMountedRef.current) return;
      const delay =
        backoffStepRef.current >= 0
          ? (BACKOFF_LADDER_MS[backoffStepRef.current] ?? BACKOFF_LADDER_MS[BACKOFF_LADDER_MS.length - 1])
          : intervalMs;
      setNextAttemptInMs(delay);
      timer = setTimeout(tick, delay);
    };

    tick();

    return () => {
      isMountedRef.current = false;
      if (timer !== undefined) clearTimeout(timer);
      inFlightAbortRef.current?.abort();
    };
  }, [opts.url, intervalMs, isPaused]);

  return { data, error, isLoading, lastModified, isPaused, nextAttemptInMs };
}
