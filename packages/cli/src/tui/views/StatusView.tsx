/**
 * `StatusView` — the TUI's `/03` tab: the observation dashboard.
 * Project + services + doctor summary + a recent-activity timeline,
 * where each run is a node observed on the context axis. Data is
 * fetched lazily (the first time the tab is opened) by running the
 * read-only `status`, `run list`, and `doctor` commands in-process.
 */

import { Box, Text, useApp, useInput } from 'ink';
import { useEffect, useRef, useState } from 'react';
import type { StatusReport } from '../../commands/status.js';
import type { DoctorReport } from '../../doctor/types.js';
import { KeyValueRow, SectionHead, Spinner, SummaryBar, TimelineRow } from '../../ui/ink/index.js';
import { palette, type Verdict } from '../../ui/theme.js';
import type { TuiContext } from '../context.js';
import { runCommandInProcess } from '../run-command.js';

export interface StatusViewProps {
  readonly ctx: TuiContext;
  readonly active: boolean;
}

interface RunRow {
  readonly id: string;
  readonly status: string;
  readonly startedAt: string;
  readonly agentType: string;
}

interface DashboardData {
  readonly status: StatusReport | null;
  readonly runs: readonly RunRow[] | null;
  readonly doctor: DoctorReport | null;
  readonly error: string | null;
}

const EMPTY: DashboardData = { status: null, runs: null, doctor: null, error: null };

export function StatusView({ ctx, active }: StatusViewProps) {
  const { exit } = useApp();
  const [data, setData] = useState<DashboardData>(EMPTY);
  const [nonce, setNonce] = useState(0);
  const fetchedOnce = useRef(false);

  useInput(
    (char) => {
      if (char === 'q') {
        exit();
        return;
      }
      if (char === 'r') {
        setData(EMPTY);
        setNonce((n) => n + 1);
      }
    },
    { isActive: active },
  );

  // Lazy fetch — only the first time the tab is opened, plus on `r`.
  // `nonce` is an intentional re-trigger signal (bumped by the `r`
  // keypress), not a value the effect reads — hence the suppression.
  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce is a deliberate re-fetch trigger.
  useEffect(() => {
    if (!active && !fetchedOnce.current) return;
    if (active) fetchedOnce.current = true;
    let cancelled = false;

    void (async () => {
      const [statusRes, runsRes] = await Promise.all([
        runCommandInProcess(['status', '--json']),
        runCommandInProcess(['run', 'list', '--json', '--limit', '6']),
      ]);
      if (cancelled) return;

      let status: StatusReport | null = null;
      let error: string | null = null;
      try {
        status = JSON.parse(statusRes.stdout) as StatusReport;
      } catch {
        error = 'could not read project status';
      }
      let runs: readonly RunRow[] = [];
      try {
        const parsed = JSON.parse(runsRes.stdout) as { ok?: boolean; runs?: RunRow[] };
        runs = parsed.runs ?? [];
      } catch {
        runs = [];
      }
      setData((prev) => ({ ...prev, status, runs, error }));

      // Doctor is slower (it probes /healthz) — fill it in after.
      const doctorRes = await runCommandInProcess(['doctor', '--json']);
      if (cancelled) return;
      let doctor: DoctorReport | null = null;
      try {
        doctor = JSON.parse(doctorRes.stdout) as DoctorReport;
      } catch {
        doctor = null;
      }
      setData((prev) => ({ ...prev, doctor }));
    })();

    return () => {
      cancelled = true;
    };
  }, [active, nonce]);

  return (
    <Box flexDirection="column" paddingX={1} paddingTop={1}>
      <SectionHead num="01" title="project" />
      {data.status !== null ? (
        <Box flexDirection="column">
          <KeyValueRow label="slug" value={data.status.project.slug ?? '(unregistered)'} labelWidth={16} />
          <KeyValueRow label="mode" value={data.status.project.mode} labelWidth={16} />
          <KeyValueRow
            tone={data.status.project.registered ? 'ok' : 'warn'}
            label="registered"
            value={data.status.project.registered ? 'yes' : 'no'}
            labelWidth={16}
          />
          <KeyValueRow label="cli version" value={`v${ctx.version}`} labelWidth={16} />
          <KeyValueRow label="home" value={ctx.coodraHome} valueTone="dim" labelWidth={16} />
        </Box>
      ) : data.error !== null ? (
        <Text color={palette.crimson}>{`  ${data.error}`}</Text>
      ) : (
        <Box paddingLeft={3}>
          <Spinner label="loading project …" />
        </Box>
      )}

      <Box marginTop={1}>
        <SectionHead num="02" title="services" />
      </Box>
      {data.status !== null ? (
        <Box flexDirection="column">
          {data.status.services.map((svc) => (
            <KeyValueRow
              key={svc.name}
              tone={svc.state === 'running' ? 'ok' : svc.state === 'stopped' ? 'skip' : 'warn'}
              label={svc.displayName}
              value={svc.state}
              {...(svc.state === 'running' ? { valueColor: palette.phosphor } : { valueTone: 'dim' as const })}
              meta={svc.port !== null ? `:${svc.port}` : '(worker)'}
              labelWidth={20}
            />
          ))}
        </Box>
      ) : (
        <Box paddingLeft={3}>
          <Spinner label="probing services …" />
        </Box>
      )}

      <Box marginTop={1}>
        <SectionHead num="03" title="doctor summary" />
      </Box>
      {data.doctor !== null ? (
        <Box flexDirection="column">
          <KeyValueRow
            tone="ok"
            label="checks passed"
            value={`${data.doctor.summary.ok} / ${data.doctor.checks.length}`}
            labelWidth={16}
          />
          <KeyValueRow
            tone={data.doctor.summary.warn > 0 ? 'warn' : 'skip'}
            label="warnings"
            value={String(data.doctor.summary.warn)}
            labelWidth={16}
          />
          <KeyValueRow
            tone={data.doctor.summary.fail > 0 ? 'fail' : 'skip'}
            label="failures"
            value={String(data.doctor.summary.fail)}
            labelWidth={16}
          />
        </Box>
      ) : (
        <Box paddingLeft={3}>
          <Spinner label="running health checks …" />
        </Box>
      )}

      <Box marginTop={1}>
        <SectionHead num="04" title="recent activity" />
      </Box>
      {data.runs !== null ? (
        data.runs.length === 0 ? (
          <Text color={palette.inkFar}>{'  no runs recorded yet — open a Claude Code session to start one'}</Text>
        ) : (
          <Box flexDirection="column">
            {data.runs.map((run) => (
              <TimelineRow
                key={run.id}
                verdict={runVerdict(run.status)}
                when={relativeTime(run.startedAt)}
                id={shortId(run.id)}
                status={run.status}
                meta={run.agentType}
              />
            ))}
          </Box>
        )
      ) : (
        <Box paddingLeft={3}>
          <Spinner label="loading runs …" />
        </Box>
      )}

      {data.runs !== null && data.doctor !== null ? (
        <Box marginTop={1}>
          <SummaryBar
            segments={[
              { text: `${data.runs.length} recent runs`, bold: true, tone: 'primary' },
              { text: `${data.doctor.summary.ok} checks ok`, color: palette.phosphor },
              ...(data.doctor.summary.fail > 0
                ? [{ text: `${data.doctor.summary.fail} failing`, color: palette.crimson }]
                : []),
              ...(data.doctor.summary.warn > 0
                ? [{ text: `${data.doctor.summary.warn} warnings`, color: palette.amber }]
                : []),
            ]}
          />
        </Box>
      ) : null}
    </Box>
  );
}

/** Map a run's `runs.status` to an axis verdict. */
function runVerdict(status: string): Verdict {
  switch (status) {
    case 'completed':
      return 'ok';
    case 'failed':
      return 'fail';
    case 'in_progress':
      return 'warn';
    default:
      // cancelled · abandoned
      return 'idle';
  }
}

/** A compact run id — `run_a8f3…`. */
function shortId(id: string): string {
  return id.length > 13 ? `${id.slice(0, 12)}…` : id;
}

/** A human relative time from an ISO timestamp. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}
