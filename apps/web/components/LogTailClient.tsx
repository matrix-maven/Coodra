'use client';

import { useEffect, useRef, useState } from 'react';

import { Checkbox, Input, StatusDot, type StatusTone } from '@/components/ui';

/**
 * `apps/web/components/LogTailClient.tsx` — client subscriber for the
 * SSE log stream.
 *
 * Refined for the new design: rounded surfaces, sentence-case labels,
 * brand-tinted status badge.
 */

export interface LogTailClientProps {
  readonly slug: string;
  readonly service: string;
  readonly initialLines: ReadonlyArray<string>;
  readonly initialOffset: number;
}

const MAX_LINES = 5000;

export function LogTailClient({ slug, service, initialLines, initialOffset }: LogTailClientProps): React.JSX.Element {
  const [lines, setLines] = useState<ReadonlyArray<string>>(initialLines);
  const [filter, setFilter] = useState('');
  const [stickyTail, setStickyTail] = useState(true);
  const [status, setStatus] = useState<'live' | 'reconnecting' | 'closed'>('live');
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const url = `/api/projects/${encodeURIComponent(slug)}/logs/${encodeURIComponent(service)}/stream?fromOffset=${initialOffset}`;
    const es = new EventSource(url);
    setStatus('live');

    es.addEventListener('lines', (ev) => {
      try {
        const parsed = JSON.parse((ev as MessageEvent).data) as { lines: string[] };
        if (Array.isArray(parsed.lines) && parsed.lines.length > 0) {
          setLines((prev) => {
            const next = [...prev, ...parsed.lines];
            return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
          });
        }
      } catch {
        // ignore malformed event
      }
    });
    es.addEventListener('error', () => {
      setStatus('reconnecting');
    });
    es.addEventListener('open', () => {
      setStatus('live');
    });

    return () => {
      es.close();
      setStatus('closed');
    };
  }, [slug, service, initialOffset]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: lines.length is the trigger; intentional dep
  useEffect(() => {
    if (!stickyTail) return;
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, stickyTail]);

  const lf = filter.toLowerCase();
  const visible = lf.length === 0 ? lines : lines.filter((l) => l.toLowerCase().includes(lf));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter (substring, case-insensitive)"
            mono
            className="w-72"
          />
          <label htmlFor="log-sticky" className="flex items-center gap-2 text-sm text-text-secondary">
            <Checkbox id="log-sticky" checked={stickyTail} onChange={(e) => setStickyTail(e.target.checked)} />
            <span>Sticky tail</span>
          </label>
        </div>
        <StatusBadge status={status} count={lines.length} visible={visible.length} />
      </div>

      <div
        ref={containerRef}
        className="h-[60vh] overflow-x-auto overflow-y-auto rounded-lg border border-border-default bg-bg-surface p-4 font-mono text-[12px] leading-relaxed text-text-primary shadow-xs"
      >
        {visible.length === 0 ? (
          <p className="text-text-tertiary">
            {lines.length === 0 ? 'No log lines yet — waiting for the service to write.' : 'No lines match the filter.'}
          </p>
        ) : (
          <pre className="whitespace-pre-wrap break-all">{visible.join('\n')}</pre>
        )}
      </div>
    </div>
  );
}

function StatusBadge({
  status,
  count,
  visible,
}: {
  readonly status: 'live' | 'reconnecting' | 'closed';
  readonly count: number;
  readonly visible: number;
}): React.JSX.Element {
  const tone: StatusTone = status === 'live' ? 'success' : status === 'reconnecting' ? 'warning' : 'neutral';
  return (
    <span className="inline-flex items-center gap-2 rounded-full bg-bg-elevated px-3 py-1 text-xs font-medium text-text-secondary">
      <StatusDot tone={tone} size="sm" />
      <span>{status}</span>
      <span className="font-mono text-text-tertiary">
        {visible}/{count}
      </span>
    </span>
  );
}
