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
  StatusDot,
  type StatusTone,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@/components/ui';
import {
  getServicesStatus,
  refreshStatusAction,
  startServicesAction,
  stopServicesAction,
} from '@/lib/actions/services';
import { getDoctorReport } from '@/lib/queries/doctor';

/**
 * `/settings/workspace` — workspace-grain admin (M04 Phase 2 S12,
 * restyled in Phase 2 UI).
 *
 * Three sections — service control (solo only), doctor summary, and
 * environment metadata. All composed from primitives so spacing,
 * card chrome, button variants, and status dots match the rest of
 * the app.
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
    <PageShell variant="workspace">
      <PageHeader
        eyebrow="Workspace"
        title="Settings"
        subtitle={
          <>
            Mode: <span className="font-mono">{mode}</span> · service control is{' '}
            {isSolo ? 'enabled' : 'disabled (team mode runs services remotely)'}.
          </>
        }
      />

      <Banners {...sp} />

      <Section title="Service control">
        {!isSolo ? (
          <Banner kind="info">
            Service start/stop is solo-mode only. In team mode the daemons run on the deployment platform and are
            managed there.
          </Banner>
        ) : (
          <ServiceControl status={statusResult} />
        )}
      </Section>

      <Section
        title="Doctor"
        subtitle="Workspace-grain essential checks. Same registry as /projects/[slug]/doctor."
        actions={
          <LinkButton href="/projects/coodra-dev/doctor" variant="ghost" size="sm">
            Full doctor report
          </LinkButton>
        }
      >
        <DoctorSummary
          ok={doctorReport.summary.ok}
          warn={doctorReport.summary.warn}
          fail={doctorReport.summary.fail}
          total={doctorReport.checks.length}
        />
      </Section>

      <Section title="Environment">
        <Card size="md">
          <dl className="grid grid-cols-1 gap-2 text-sm md:grid-cols-2">
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
        </Card>
      </Section>
    </PageShell>
  );
}

function ServiceControl({ status }: { readonly status: Awaited<ReturnType<typeof getServicesStatus>> | null }) {
  if (status === null) return null;
  const services = status.ok ? status.services : [];
  return (
    <div className="flex flex-col gap-(--space-stack)">
      <div className="flex flex-wrap items-center gap-3">
        <form action={startServicesAction} className="inline-flex">
          <Button type="submit" variant="primary">
            Start all services
          </Button>
        </form>
        <form action={stopServicesAction} className="inline-flex">
          <Button type="submit" variant="destructive">
            Stop all services
          </Button>
        </form>
        <form action={refreshStatusAction} className="inline-flex">
          <Button type="submit" variant="secondary" leftIcon={<RefreshIcon className="h-3 w-3" />}>
            Refresh status
          </Button>
        </form>
      </div>

      {!status.ok ? (
        <Banner kind="error" code="status_failed">
          {status.howToFix}
        </Banner>
      ) : services.length === 0 ? (
        <EmptyState
          title="No services running"
          body={'Click "Start all services" to spawn hooks-bridge + mcp-server.'}
        />
      ) : (
        <Table>
          <THead>
            <TR hoverable={false}>
              <TH>Service</TH>
              <TH>Status</TH>
              <TH>PID</TH>
              <TH>Port</TH>
              <TH>Health</TH>
              <TH align="right">Action</TH>
            </TR>
          </THead>
          <TBody>
            {services.map((s) => (
              <TR key={s.name}>
                <TD mono>{s.name}</TD>
                <TD>
                  <StatusDot tone={statusTone(s.status)} label={s.status} />
                </TD>
                <TD mono muted>
                  {s.pid ?? '—'}
                </TD>
                <TD mono muted>
                  {s.port ?? '—'}
                </TD>
                <TD mono muted>
                  {s.health ?? '—'}
                </TD>
                <TD align="right">
                  <form action={stopServicesAction} className="inline-flex">
                    <input type="hidden" name="service" value={s.name} />
                    <Button type="submit" size="sm" variant="ghost">
                      Stop
                    </Button>
                  </form>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
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
    <div className="flex flex-wrap items-center gap-2">
      <Pill colorClass="bg-status-success/15 text-status-success">{ok} green</Pill>
      <Pill colorClass="bg-status-warning/15 text-status-warning">{warn} yellow</Pill>
      <Pill colorClass="bg-status-error/15 text-status-error">{fail} red</Pill>
      <Pill colorClass="bg-bg-elevated text-text-tertiary">of {total} total</Pill>
    </div>
  );
}

function Pill({ colorClass, children }: { readonly colorClass: string; readonly children: React.ReactNode }) {
  return <span className={`px-3 py-1 text-xs font-medium ${colorClass}`}>{children}</span>;
}

function Field({ label, value }: { readonly label: string; readonly value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-xs font-medium text-text-secondary">{label}</dt>
      <dd className="text-text-primary">{value}</dd>
    </div>
  );
}

function Banners(sp: SearchParams) {
  if (sp.started === undefined && sp.stopped === undefined && sp.error === undefined) return null;
  return (
    <div className="flex flex-col gap-2">
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
