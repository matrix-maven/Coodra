import { RunStatusChip } from '@/components/RunStatusChip';
import {
  Banner,
  Button,
  Card,
  Checkbox,
  DownloadIcon,
  EmptyState,
  FormRow,
  Input,
  LinkButton,
  PageHeader,
  PageShell,
  Section,
  Table,
  TBody,
  TD,
  TH,
  THead,
  Tile,
  TR,
} from '@/components/ui';
import { deleteProjectAction, renameProjectAction, resetProjectAction } from '@/lib/actions/projects';
import { resolveProjectFromParams } from '@/lib/project-context';

/**
 * `/projects/[slug]/settings` — project settings + admin actions
 * (M04 Phase 2 S14, restyled in Phase 2 UI).
 *
 * Sections: Overview / Recent runs / Export / Rename / Reset / Delete.
 * The __global__ sentinel hides Rename + Delete (also enforced server-
 * side in the action).
 */
export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly error?: string;
  readonly errorMessage?: string;
  readonly reset?: string;
  readonly summary?: string;
  readonly renamed?: string;
}

const GLOBAL_PROJECT_SLUG = '__global__';

export default async function ProjectSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const project = await resolveProjectFromParams(params);
  const sp = await searchParams;
  const isSentinel = project.slug === GLOBAL_PROJECT_SLUG;
  const statusEntries = Object.entries(project.statusCounts).sort(([a], [b]) => a.localeCompare(b));
  const totalRuns = project.runCount;

  return (
    <PageShell>
      <PageHeader
        eyebrow={`/05 · SYSTEM · PROJECT · ${project.slug}`}
        title={
          <>
            <em>Settings</em>, with intent.
          </>
        }
        subtitle={
          isSentinel ? (
            <>
              <span className="font-mono text-accent">__global__</span> sentinel — F7 invariant. Rename + delete
              disabled.
            </>
          ) : (
            <>
              {totalRuns} run{totalRuns === 1 ? '' : 's'} · created{' '}
              <span className="font-mono text-accent">{project.createdAt.toISOString().slice(0, 10)}</span>. Rename,
              reset, or delete this project.
            </>
          )
        }
        meta={
          <>
            <strong className="font-medium text-text-primary">{project.slug}</strong>
            <br />
            org · {project.orgId}
            <br />
            id · {project.id.slice(0, 13)}…
          </>
        }
      />

      <Banners {...sp} />

      <Section title="Overview">
        <div className="grid gap-4 md:grid-cols-3">
          <Tile label="Total runs" value={totalRuns} tone={totalRuns > 0 ? 'info' : 'neutral'} />
          {statusEntries.map(([status, count]) => (
            <Tile key={status} label={status} value={count} tone="neutral" hint="status histogram" />
          ))}
        </div>
      </Section>

      <Section title="Project info">
        <Card size="md">
          <dl className="grid grid-cols-1 gap-2 text-sm md:grid-cols-2">
            <Field label="ID" value={<span className="break-all font-mono text-xs">{project.id}</span>} />
            <Field label="Org" value={<span className="font-mono">{project.orgId}</span>} />
            <Field label="Name" value={project.name} />
            <Field
              label="Created"
              value={
                <span className="font-mono">{project.createdAt.toISOString().slice(0, 19).replace('T', ' ')}</span>
              }
            />
          </dl>
        </Card>
      </Section>

      <Section title={`Recent runs (${project.recentRuns.length})`}>
        {project.recentRuns.length === 0 ? (
          <EmptyState title="No runs yet" body="No runs in this project yet." />
        ) : (
          <Table>
            <THead>
              <TR hoverable={false}>
                <TH>ID</TH>
                <TH>Session</TH>
                <TH>Agent</TH>
                <TH>Status</TH>
                <TH>Started</TH>
              </TR>
            </THead>
            <TBody>
              {project.recentRuns.map((run) => (
                <TR key={run.id}>
                  <TD mono>
                    <a
                      href={`/projects/${encodeURIComponent(project.slug)}/runs/${encodeURIComponent(run.id)}`}
                      className="text-text-code hover:text-brand-hover"
                    >
                      {run.id}
                    </a>
                  </TD>
                  <TD mono muted>
                    {run.sessionId}
                  </TD>
                  <TD mono>{run.agentType}</TD>
                  <TD>
                    <RunStatusChip status={run.status} />
                  </TD>
                  <TD mono muted>
                    {run.startedAt.toISOString().slice(0, 19).replace('T', ' ')}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Section>

      <Section title="Export">
        <Card size="md">
          <div className="flex flex-col gap-3">
            <p className="text-sm text-text-secondary">
              Download every per-project audit row as JSONL — one object per line, tagged by{' '}
              <span className="font-mono">type</span> (project / run / run_event / decision / policy_decision /
              context_pack).
            </p>
            <LinkButton
              href={`/projects/${encodeURIComponent(project.slug)}/settings/export`}
              variant="primary"
              leftIcon={<DownloadIcon className="h-3 w-3" />}
              download
            >
              Download JSONL
            </LinkButton>
          </div>
        </Card>
      </Section>

      {!isSentinel ? (
        <Section title="Rename">
          <Card size="md">
            <form action={renameProjectAction} className="flex flex-col gap-4">
              <input type="hidden" name="identifier" value={project.id} />
              <p className="text-sm text-text-primary">
                Change the project's slug. The URL becomes <span className="font-mono">/projects/&lt;new-slug&gt;</span>
                . Runs / events / context packs stay attached. Other devices that have the project opened will get a 404
                until they refresh.
              </p>
              <FormRow inputId="rename-newSlug" label="New slug" required>
                <Input
                  id="rename-newSlug"
                  name="newSlug"
                  required
                  mono
                  pattern="[a-z0-9_-]+"
                  placeholder="my-renamed-project"
                />
              </FormRow>
              <FormRow
                inputId="rename-confirmation"
                label="Type the new slug to confirm"
                required
                helper="Must match the slug above exactly."
              >
                <Input
                  id="rename-confirmation"
                  name="confirmation"
                  required
                  mono
                  autoComplete="off"
                  placeholder="(repeat the new slug)"
                />
              </FormRow>
              <Button type="submit" variant="primary">
                Rename project
              </Button>
            </form>
          </Card>
        </Section>
      ) : null}

      <Section title="Reset project">
        {isSentinel ? (
          <Banner kind="warning">
            The <span className="font-mono">__global__</span> sentinel project (F7 invariant) cannot be reset from this
            UI. Run <span className="font-mono">coodra project reset __global__ --force</span> after backing up
            data.db.
          </Banner>
        ) : (
          <Card size="md">
            <form action={resetProjectAction} className="flex flex-col gap-4">
              <input type="hidden" name="identifier" value={project.id} />
              <p className="text-sm text-text-primary">
                Resetting <span className="font-mono">{project.slug}</span> will delete every per-run audit row for this
                project: runs, run_events, decisions, policy_decisions, context_packs.
              </p>
              <ul className="ml-6 list-disc text-xs text-text-secondary">
                <li>Total runs to delete: {totalRuns}</li>
                <li>Cascade order matches the CLI's `coodra project reset` (FK-aware)</li>
                <li>Default: keeps policies + policy_rules + project-scoped kill_switches</li>
              </ul>
              <label htmlFor="reset-alsoDeletePolicies" className="flex items-center gap-2 text-sm">
                <Checkbox id="reset-alsoDeletePolicies" name="alsoDeletePolicies" />
                <span>Also delete policies + policy_rules + project-scoped kill_switches</span>
              </label>
              <FormRow inputId="reset-confirm" label="Type the project slug to confirm" required>
                <Input
                  id="reset-confirm"
                  name="confirmation"
                  required
                  mono
                  autoComplete="off"
                  placeholder={project.slug}
                />
              </FormRow>
              <Button type="submit" variant="destructive">
                Reset project
              </Button>
            </form>
          </Card>
        )}
      </Section>

      {!isSentinel ? (
        <Section title="Delete project (irreversible)">
          <Card size="md" tone="danger">
            <form action={deleteProjectAction} className="flex flex-col gap-4">
              <input type="hidden" name="identifier" value={project.id} />
              <p className="text-sm text-text-primary">
                Permanently delete <span className="font-mono">{project.slug}</span> AND every per-run audit row,
                policy, policy_rule, kill_switch, and context pack scoped to this project. The projects row itself is
                also dropped — slug becomes available for re-init. There is no undo.
              </p>
              <FormRow
                inputId="delete-confirm"
                label="Type the project slug to confirm"
                required
                helper={
                  <>
                    <span className="font-mono">{project.slug}</span> exactly
                  </>
                }
              >
                <Input
                  id="delete-confirm"
                  name="confirmation"
                  required
                  mono
                  autoComplete="off"
                  placeholder={project.slug}
                  invalid
                />
              </FormRow>
              <Button type="submit" variant="destructive">
                Delete permanently
              </Button>
            </form>
          </Card>
        </Section>
      ) : null}
    </PageShell>
  );
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
  if (sp.reset === undefined && sp.renamed === undefined && sp.error === undefined) return null;
  return (
    <div className="flex flex-col gap-2">
      {sp.reset !== undefined ? (
        <Banner kind="success">
          Project reset.{sp.summary !== undefined ? <span className="ml-2 font-mono text-xs">{sp.summary}</span> : null}
        </Banner>
      ) : null}
      {sp.renamed !== undefined ? (
        <Banner kind="success">
          Renamed from <span className="font-mono">{sp.renamed}</span>.
        </Banner>
      ) : null}
      {sp.error !== undefined ? (
        <Banner kind="error" code={sp.error}>
          {sp.errorMessage ?? '—'}
        </Banner>
      ) : null}
    </div>
  );
}
