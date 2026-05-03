'use client';

/**
 * `apps/web/lib/poll.ts` — client-side polling adapter per spec §8 + OQ-2 lock.
 *
 * S1 ships this skeleton; the full implementation (interval, pause-when-
 * hidden, exponential backoff, If-Modified-Since semantics) lands in S4
 * alongside the live run dashboard. The hook signature is locked here so
 * downstream slices import the stable interface.
 *
 * Contract:
 *   - `intervalMs` default: 1500 (per OQ-2 lock)
 *   - `pauseWhenHidden` default: true (Page Visibility API)
 *   - Backoff on error: 1.5s → 3s → 6s → 12s → 30s (cap), reset on success
 *   - `If-Modified-Since` round-trips to short-circuit unchanged ticks
 */

import { useEffect, useState } from 'react';

export interface PollOptions<_T = unknown> {
  readonly url: string;
  readonly intervalMs?: number;
  readonly pauseWhenHidden?: boolean;
  readonly signal?: AbortSignal;
}

export interface PollResult<T> {
  readonly data: T | undefined;
  readonly error: Error | undefined;
  readonly isLoading: boolean;
}

/**
 * S1 stub. Returns initial loading state; never fetches. Replace with
 * the real implementation in S4 — keep the signature.
 */
export function usePoll<T>(_opts: PollOptions<T>): PollResult<T> {
  const [state] = useState<PollResult<T>>({ data: undefined, error: undefined, isLoading: true });
  useEffect(() => {
    // Real interval + fetch + If-Modified-Since lands in S4.
  }, []);
  return state;
}
