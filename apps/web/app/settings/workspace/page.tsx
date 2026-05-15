import {
  Banner,
  Button,
  Card,
  EmptyState,
  LinkButton,
  PageHeader,
  PageShell,
  RefreshIcon,
  Section,
  StatPill,
  StatusDot,
  type StatusTone,
} from '@/components/ui';
import {
  getServicesStatus,
  refreshStatusAction,
  startServicesAction,
  stopServicesAction,
} from '@/lib/actions/services';
import { getDoctorReport } from '@/lib/queries/doctor';

/**
 * `/settings/workspace` — editorial workspace admin (mirrors brand-kit
 * Workspace, screen 11). Service rows · doctor summary · environment.
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
  const mode = process.env.COODRA_MODE === 'team' ? 'team' : 'solo';
  const isSolo = mode === 'solo';

  const [statusResult, doctorReport] = await Promise.all([
    isSolo ? getServicesStatus() : Promise.resolve(null),
    getDoctorReport('essential'),
  ]);

  const services = statusResult?.ok ? statusResult.services : [];
  const healthyCount = services.filter(
    (s) => s.status === 'running' || s.status === 'healthy' || s.status === 'ok',
  ).length;

  return (
    <PageShell variant="workspace">
      <PageHeader
        eyebrow="/05 · SYSTEM · WORKSPACE"
        title={
          <>
            Local <em>services</em>.
          </>
        }
        subtitle={
          <>
            All Coodra daemons running on this machine. Start, stop, tail logs. Solo mode runs MCP + Hooks; team mode
            adds Sync. Mode: <span className="font-mono text-accent">{mode}</span> · service control{' '}
            {isSolo ? 'enabled' : 'remote-managed'}.
          </>
        }
        meta={
          <>
            <strong className="font-medium text-text-primary">
              {healthyCount} of {services.length || 3} healthy
            </strong>
            <br />
            mode · {mode}
            <br />
            uptime · {services.length > 0 ? '14h' : '—'}
          </>
        }
        actions={
          <>
            <LinkButton href="/projects/coodra-dev/doctor" variant="ghost">
              Doctor
            </LinkButton>
            <form action={refreshStatusAction} className="inline-flex">
              <Button type="submit" variant="primary" leftIcon={<RefreshIcon className="h-3 w-3" />}>
                Refresh
              </Button>
            </form>
          </>
        }
      />

      <Banners {...sp} />

      <div className="mb-12">
        <Section
          title={
            <>
              Service <em>control</em>
            </>
          }
          count={isSolo ? `${services.length} services` : 'team mode'}
        >
          {!isSolo ? (
            <Banner kind="info">
              Service start/stop is solo-mode only. In team mode the daemons run on the deployment platform and are
              managed there.
            </Banner>
          ) : (
            <ServiceControl status={statusResult} />
          )}
        </Section>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card size="md">
          <Section
            title={
              <>
                Doctor · <em>{doctorReport.checks.length} checks</em>
              </>
            }
            count="essential set"
            compact
            actions={
              <LinkButton href="/projects/coodra-dev/doctor" variant="ghost" size="sm">
                Full report
              </LinkButton>
            }
          >
            <div className="grid grid-cols-2 gap-2 font-mono text-[11px] tracking-[0.04em] text-text-tertiary">
              {doctorReport.checks.slice(0, 10).map((c) => (
                <div key={c.id} className="flex items-center gap-2">
                  <span
                    className={
                      c.status === 'green'
                        ? 'text-accent'
                        : c.status === 'yellow'
                          ? 'text-status-warning'
                          : c.status === 'red'
                            ? 'text-status-error'
                            : 'text-text-muted'
                    }
                  >
                    {c.status === 'green' ? '✓' : c.status === 'yellow' ? '!' : c.status === 'red' ? '✗' : '·'}
                  </span>
                  <span className="truncate">{c.name}</span>
                </div>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-rule pt-4">
              <StatPill tone="ok">{doctorReport.summary.ok} green</StatPill>
              <StatPill tone="caution">{doctorReport.summary.warn} yellow</StatPill>
              <StatPill tone="warn">{doctorReport.summary.fail} red</StatPill>
              <StatPill tone="neutral">of {doctorReport.checks.length}</StatPill>
            </div>
          </Section>
        </Card>

        <Card size="md">
          <Section title={<>Environment</>} compact>
            <dl className="flex flex-col">
              <Field label="COODRA_MODE" value={mode} />
              <Field label="DATABASE_URL" value={process.env.DATABASE_URL ? '*** (set)' : 'not set'} />
              <Field label="COODRA_LOGS_DIR" value={process.env.COODRA_LOGS_DIR ?? '~/.coodra/logs'} />
              <Field label="COODRA_PACKS_ROOT" value={process.env.COODRA_PACKS_ROOT ?? 'walked from cwd'} />
            </dl>
          </Section>
        </Card>
      </div>
    </PageShell>
  );
}

function ServiceControl({ status }: { readonly status: Awaited<ReturnType<typeof getServicesStatus>> | null }) {
  if (status === null) return null;
  const services = status.ok ? status.services : [];
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <form action={startServicesAction} className="inline-flex">
          <Button type="submit" variant="primary">
            Start all
          </Button>
        </form>
        <form action={stopServicesAction} className="inline-flex">
          <Button type="submit" variant="destructive">
            Stop all
          </Button>
        </form>
        <form action={refreshStatusAction} className="inline-flex">
          <Button type="submit" variant="ghost" leftIcon={<RefreshIcon className="h-3 w-3" />}>
            Refresh
          </Button>
        </form>
      </div>

      {!status.ok ? (
        <Banner kind="error" code="status_failed">
          {status.howToFix}
        </Banner>
      ) : services.length === 0 ? (
        <EmptyState
          title={
            <>
              No <em>services</em> running
            </>
          }
          body={'Click "Start all" to spawn hooks-bridge + mcp-server.'}
        />
      ) : (
        <div className="flex flex-col gap-1.5">
          {services.map((s) => (
            <ServiceRow key={s.name} {...s} />
          ))}
        </div>
      )}
    </div>
  );
}

function ServiceRow({
  name,
  status,
  pid,
  port,
  health,
}: {
  readonly name: string;
  readonly status: string;
  readonly pid?: number;
  readonly port?: number;
  readonly health?: string;
}) {
  const tone = statusTone(status);
  return (
    <div className="grid grid-cols-[1fr_200px_200px_auto] items-center gap-6 border border-rule bg-bg-surface px-6 py-5">
      <div>
        <div className="heading-display text-[22px] text-text-primary">
          <span>{name}</span>
        </div>
        <div className="font-mono text-[11px] tracking-[0.04em] text-text-tertiary">
          {port !== undefined ? `127.0.0.1:${port}` : '—'} · {health ?? 'no health endpoint'}
        </div>
      </div>
      <div>
        <StatusDot tone={tone} label={status} />
        <div className="mt-1.5 font-mono text-[11px] tracking-[0.04em] text-text-tertiary">pid {pid ?? '—'}</div>
      </div>
      <div className="font-mono text-[11px] tracking-[0.04em] text-text-tertiary">
        last health check
        <br />
        {health ?? '—'}
      </div>
      <div className="flex gap-1.5">
        <form action={stopServicesAction} className="inline-flex">
          <input type="hidden" name="service" value={name} />
          <Button type="submit" size="sm" variant="ghost">
            Stop
          </Button>
        </form>
      </div>
    </div>
  );
}

function statusTone(status: string): StatusTone {
  if (status === 'running' || status === 'healthy' || status === 'ok') return 'success';
  if (status === 'starting' || status === 'unhealthy' || status === 'degraded') return 'warning';
  if (status === 'stopped' || status === 'not_running') return 'neutral';
  if (status === 'unknown' || status === 'no_pidfile') return 'neutral';
  return 'error';
}

function Field({ label, value }: { readonly label: string; readonly value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-rule py-3 last:border-b-0">
      <dt className="font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted">{label}</dt>
      <dd className="truncate font-mono text-[11px] tracking-[0.04em] text-text-primary">{value}</dd>
    </div>
  );
}

function Banners(sp: SearchParams) {
  if (sp.started === undefined && sp.stopped === undefined && sp.error === undefined) return null;
  return (
    <div className="mb-8 flex flex-col gap-2">
      {sp.started !== undefined ? <Banner kind="success">Services started.</Banner> : null}
      {sp.stopped !== undefined ? <Banner kind="success">Services stopped.</Banner> : null}
      {sp.error !== undefined ? (
        <Banner kind="error" code={sp.error}>
          {sp.errorMessage ?? '—'}
        </Banner>
      ) : null}
    </div>
  );
}
