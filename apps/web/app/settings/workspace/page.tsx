import Link from 'next/link';

import {
  getServicesStatus,
  refreshStatusAction,
  startServicesAction,
  stopServicesAction,
} from '@/lib/actions/services';
import { getDoctorReport } from '@/lib/queries/doctor';

/**
 * `/settings/workspace` — workspace-grain admin surface (M04 Phase 2 S12).
 *
 * Three sections:
 *   1. Service control — Start / Stop buttons (solo-mode only) +
 *      live status of mcp-server, hooks-bridge, sync-daemon. Status
 *      reads via runStatus({ json: true }) which probes pidfile +
 *      /healthz for each service.
 *   2. Workspace doctor — re-uses the S8 essential check set
 *      (`runDoctorReport({ essential: true })`).
 *   3. Mode + env metadata — read-only display of CONTEXTOS_MODE +
 *      database kind so an operator can confirm what they're
 *      pointing at.
 *
 * The whole surface degrades gracefully in team mode: service
 * control is hidden (the web app can't manage remote daemons), but
 * the doctor + metadata sections still render.
 */

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly started?: string;
  readonly stopped?: string;
  readonly refreshed?: string;
  readonly error?: string;
  readonly errorMessage?: string;
}

export default async function WorkspaceSettingsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const mode = process.env.CONTEXTOS_MODE === 'team' ? 'team' : 'solo';
  const isSolo = mode === 'solo';

  const [statusResult, doctorReport] = await Promise.all([
    isSolo ? getServicesStatus() : Promise.resolve(null),
    getDoctorReport('essential'),
  ]);

  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-8 px-8 py-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-4xl font-black uppercase tracking-wide text-(--color-text-primary)">
          Workspace settings
        </h1>
        <p className="text-sm text-(--color-text-secondary)">
          Mode: <span className="font-mono">{mode}</span> · service control is{' '}
          {isSolo ? 'enabled' : 'disabled (team mode runs services remotely)'}.
        </p>
      </header>

      <Banners {...sp} />

      <Section title="Service control">
        {!isSolo ? (
          <p className="border-l-4 border-(--color-status-info) bg-(--color-status-info)/10 px-4 py-3 text-sm">
            Service start/stop is solo-mode only. In team mode the daemons run on the deployment platform and are
            managed there.
          </p>
        ) : (
          <ServiceControl status={statusResult} />
        )}
      </Section>

      <Section title="Doctor (workspace-grain essential checks)">
        <DoctorSummary
          ok={doctorReport.summary.ok}
          warn={doctorReport.summary.warn}
          fail={doctorReport.summary.fail}
          total={doctorReport.checks.length}
        />
        <Link
          href="/projects/coodra-dev/doctor"
          className="font-display text-xs font-bold uppercase tracking-wider text-(--color-brand) hover:text-(--color-brand-hover)"
        >
          View full doctor report ▸
        </Link>
      </Section>

      <Section title="Environment">
        <dl className="grid grid-cols-1 gap-2 border border-(--color-border-subtle) bg-(--color-bg-surface) p-4 text-sm md:grid-cols-2">
          <Field label="CONTEXTOS_MODE" value={<span className="font-mono">{mode}</span>} />
          <Field
            label="DATABASE_URL"
            value={<span className="font-mono">{process.env.DATABASE_URL ? '*** (set)' : 'not set'}</span>}
          />
          <Field
            label="CONTEXTOS_LOGS_DIR"
            value={<span className="font-mono">{process.env.CONTEXTOS_LOGS_DIR ?? '~/.contextos/logs'}</span>}
          />
          <Field
            label="CONTEXTOS_PACKS_ROOT"
            value={<span className="font-mono">{process.env.CONTEXTOS_PACKS_ROOT ?? 'walked from cwd'}</span>}
          />
        </dl>
      </Section>
    </div>
  );
}

function ServiceControl({ status }: { readonly status: Awaited<ReturnType<typeof getServicesStatus>> | null }) {
  if (status === null) return null;
  const services = status.ok ? status.services : [];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <form action={startServicesAction}>
          <button
            type="submit"
            className="bg-(--color-brand) px-4 py-2 font-display text-xs font-bold uppercase tracking-wider text-white hover:bg-(--color-brand-hover)"
          >
            Start all services
          </button>
        </form>
        <form action={stopServicesAction}>
          <button
            type="submit"
            className="border border-(--color-status-error)/40 bg-(--color-bg-base) px-4 py-2 font-display text-xs font-bold uppercase tracking-wider text-(--color-status-error) hover:bg-(--color-status-error)/10"
          >
            Stop all services
          </button>
        </form>
        <form action={refreshStatusAction}>
          <button
            type="submit"
            className="border border-(--color-border-default) bg-(--color-bg-base) px-4 py-2 font-display text-xs font-bold uppercase tracking-wider text-(--color-text-primary) hover:border-(--color-brand) hover:text-(--color-brand)"
          >
            ↻ Refresh status
          </button>
        </form>
      </div>

      {!status.ok ? (
        <p className="border-l-4 border-(--color-status-error) bg-(--color-status-error)/10 px-4 py-3 text-sm">
          ✕ Status check failed: {status.howToFix}
        </p>
      ) : services.length === 0 ? (
        <p className="border border-(--color-border-subtle) bg-(--color-bg-surface) p-6 text-sm text-(--color-text-secondary)">
          No services running yet. Click "Start all services" to spawn hooks-bridge + mcp-server.
        </p>
      ) : (
        <table className="w-full border border-(--color-border-subtle)">
          <thead className="bg-(--color-bg-elevated)">
            <tr>
              <Th>Service</Th>
              <Th>Status</Th>
              <Th>PID</Th>
              <Th>Port</Th>
              <Th>Health</Th>
              <Th>Stop</Th>
            </tr>
          </thead>
          <tbody>
            {services.map((s) => (
              <tr key={s.name} className="border-b border-(--color-border-subtle) hover:bg-(--color-bg-surface)">
                <td className="px-3 py-2 font-mono text-sm text-(--color-text-primary)">{s.name}</td>
                <td className="px-3 py-2">
                  <StatusDot status={s.status} />
                </td>
                <td className="px-3 py-2 font-mono text-xs text-(--color-text-tertiary)">{s.pid ?? '—'}</td>
                <td className="px-3 py-2 font-mono text-xs text-(--color-text-tertiary)">{s.port ?? '—'}</td>
                <td className="px-3 py-2 font-mono text-xs text-(--color-text-secondary)">{s.health ?? '—'}</td>
                <td className="px-3 py-2">
                  <form action={stopServicesAction}>
                    <input type="hidden" name="service" value={s.name} />
                    <button
                      type="submit"
                      className="font-display text-xs font-bold uppercase tracking-wider text-(--color-status-error) hover:opacity-80"
                    >
                      Stop
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function StatusDot({ status }: { readonly status: string }) {
  const tone =
    status === 'running' || status === 'healthy' || status === 'ok'
      ? 'bg-(--color-status-success)'
      : status === 'starting' || status === 'unhealthy' || status === 'degraded'
        ? 'bg-(--color-status-warning)'
        : status === 'stopped' || status === 'not_running'
          ? 'bg-(--color-text-tertiary)'
          : 'bg-(--color-status-error)';
  return (
    <span className="flex items-center gap-2">
      <span className={`inline-block h-3 w-3 rounded-full ${tone}`} />
      <span className="font-mono text-xs">{status}</span>
    </span>
  );
}

function DoctorSummary({
  ok,
  warn,
  fail,
  total,
}: {
  readonly ok: number;
  readonly warn: number;
  readonly fail: number;
  readonly total: number;
}) {
  return (
    <div className="flex gap-2">
      <Pill colorClass="bg-(--color-status-success)/15 text-(--color-status-success)">{ok} green</Pill>
      <Pill colorClass="bg-(--color-status-warning)/15 text-(--color-status-warning)">{warn} yellow</Pill>
      <Pill colorClass="bg-(--color-status-error)/15 text-(--color-status-error)">{fail} red</Pill>
      <Pill colorClass="bg-(--color-bg-elevated) text-(--color-text-tertiary)">of {total}</Pill>
    </div>
  );
}

function Pill({ colorClass, children }: { readonly colorClass: string; readonly children: React.ReactNode }) {
  return (
    <span className={`px-3 py-1 font-display text-xs font-bold uppercase tracking-wider ${colorClass}`}>
      {children}
    </span>
  );
}

function Section({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-display text-xl font-bold uppercase tracking-wide text-(--color-text-primary)">{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, value }: { readonly label: string; readonly value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="font-display text-xs font-bold uppercase tracking-wider text-(--color-text-secondary)">{label}</dt>
      <dd className="text-(--color-text-primary)">{value}</dd>
    </div>
  );
}

function Banners(sp: SearchParams) {
  return (
    <div className="flex flex-col gap-2">
      {sp.started !== undefined ? <Banner kind="success">✓ Services started.</Banner> : null}
      {sp.stopped !== undefined ? <Banner kind="success">✓ Services stopped.</Banner> : null}
      {sp.error !== undefined ? (
        <Banner kind="error">
          ✕ {sp.error}
          {sp.errorMessage !== undefined ? <span className="ml-2">{sp.errorMessage}</span> : null}
        </Banner>
      ) : null}
    </div>
  );
}

function Banner({
  kind,
  children,
}: {
  readonly kind: 'success' | 'info' | 'error';
  readonly children: React.ReactNode;
}) {
  const colors: Record<'success' | 'info' | 'error', string> = {
    success: 'border-(--color-status-success) bg-(--color-status-success)/10',
    info: 'border-(--color-status-info) bg-(--color-status-info)/10',
    error: 'border-(--color-status-error) bg-(--color-status-error)/10',
  };
  return <div className={`border-l-4 ${colors[kind]} px-4 py-2 text-sm`}>{children}</div>;
}

function Th({ children }: { readonly children: React.ReactNode }) {
  return (
    <th className="px-3 py-2 text-left font-display text-xs font-bold uppercase tracking-wider text-(--color-text-secondary)">
      {children}
    </th>
  );
}
