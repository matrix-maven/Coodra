import {
  Banner,
  Button,
  Card,
  EmptyState,
  EventRow,
  Input,
  KsModeButton,
  PageHeader,
  PageShell,
  PauseIcon,
  PlayIcon,
  Section,
  Select,
  StatPill,
  Table,
  TBody,
  TD,
  Textarea,
  TH,
  THead,
  TR,
} from '@/components/ui';
import { pauseAction, resumeAction } from '@/lib/actions/kill-switches';
import { getActor } from '@/lib/auth';
import { resolveProjectFromParams } from '@/lib/project-context';
import { listActive, MODES, SCOPES } from '@/lib/queries/kill-switches';

/**
 * `/projects/[slug]/kill-switches` — editorial pause / resume.
 *
 * Mirrors brand-kit Kill Switches (screen 07): hero with phosphor
 * italic, three-up mode panel (Soft / Hard / Read-only), audit-aware
 * field rows. Right column shows active switches + recent history.
 */

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly paused?: string;
  readonly resumed?: string;
  readonly duplicate?: string;
  readonly scope?: string;
  readonly target?: string;
  readonly mode?: string;
  readonly error?: string;
}

export default async function KillSwitchesPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const project = await resolveProjectFromParams(params);
  const sp = await searchParams;
  const actor = await getActor();
  const active = await listActive();
  const selectedMode = (sp.mode === 'soft' ? 'soft' : 'hard') as 'soft' | 'hard';

  return (
    <PageShell>
      <PageHeader
        eyebrow="/03 · GOVERN · KILL SWITCHES"
        title={
          <>
            Stop work, <em>fast</em>.
          </>
        }
        subtitle={
          <>
            A kill switch is a deny-all sitting in front of the policy chain. Pause one project, one tool, or every
            agent. Hard mode denies everything; soft mode warns. Toggle anytime — agents see it before their next call.{' '}
            <span className="text-text-muted">
              {actor.mode === 'team'
                ? 'Pauses propagate to all developers within ~10s.'
                : 'Solo mode — local only, no cross-developer propagation.'}
            </span>
          </>
        }
        meta={
          <>
            <strong className="font-medium text-text-primary">{active.length} active</strong>
            <br />
            scope · project
            <br />
            mode · {selectedMode}
          </>
        }
      />

      <Banners {...sp} />

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Pause panel */}
        <Card size="lg">
          <Section
            title={
              <>
                Pause <em>{project.slug}</em>
              </>
            }
            count="scope · project"
            compact
          >
            <form action={pauseAction} className="flex flex-col gap-5">
              {/* Mode triplet */}
              <div className="grid grid-cols-3 gap-2">
                <KsModeButton title="Soft" sub="Warn" active={selectedMode === 'soft'} />
                <KsModeButton title={<em>Hard</em>} sub="Deny all" active={selectedMode === 'hard'} />
                <KsModeButton title="Read-only" sub="No writes" disabled />
              </div>
              <input type="hidden" name="mode" value={selectedMode} />

              <FieldRow label="Scope">
                <Select id="kill-scope" name="scope" defaultValue={sp.scope ?? 'project'} required>
                  {SCOPES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              </FieldRow>

              <FieldRow label="Target" hint="Leave empty when scope is global.">
                <Input
                  id="kill-target"
                  name="target"
                  placeholder="Bash | my-project | claude_code"
                  defaultValue={sp.target ?? project.slug}
                />
              </FieldRow>

              <FieldRow label="Mode" hint="Hard returns DENY; soft allows + writes a policy_decisions audit row.">
                <Select id="kill-mode" name="modeSelect" defaultValue={selectedMode} required>
                  {MODES.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </Select>
              </FieldRow>

              <FieldRow label="Auto-resume after" hint="Optional ISO 8601 — leave empty for manual resume.">
                <Input id="kill-expires" name="expiresAt" placeholder="2026-05-04T22:00:00Z" />
              </FieldRow>

              <FieldRow label="Reason" hint="Embedded in every deny response. Visible to the agent.">
                <Textarea
                  id="kill-reason"
                  name="reason"
                  required
                  sans
                  placeholder="why this kill switch — operator audit context"
                  rows={3}
                />
              </FieldRow>

              {sp.duplicate !== undefined ? <input type="hidden" name="force" value="true" /> : null}

              <div className="mt-2 flex items-center gap-2 border-t border-rule pt-5">
                <Button
                  type="submit"
                  variant="primary"
                  className="flex-1"
                  leftIcon={<PauseIcon className="h-3.5 w-3.5" />}
                >
                  {sp.duplicate !== undefined ? 'Pause anyway' : 'Pause now'}
                </Button>
                <Button type="reset" variant="ghost">
                  Cancel
                </Button>
              </div>
            </form>
          </Section>
        </Card>

        {/* Active + history */}
        <div className="flex flex-col gap-5">
          <Card size="md">
            <Section
              title={
                <>
                  Active <em>switches</em>
                </>
              }
              count={
                active.length === 0 ? (
                  <StatPill tone="ok" dot>
                    None
                  </StatPill>
                ) : (
                  <StatPill tone="caution" dot>
                    {active.length} active
                  </StatPill>
                )
              }
              compact
            >
              {active.length === 0 ? (
                <div className="border border-dashed border-rule px-6 py-10 text-center font-mono text-[11px] tracking-[0.05em] text-text-tertiary">
                  No agents are paused.
                  <br />
                  Bridge enforcement runs through policy normally.
                </div>
              ) : (
                <Table>
                  <THead>
                    <TR hoverable={false}>
                      <TH>Mode</TH>
                      <TH>Scope</TH>
                      <TH>Reason</TH>
                      <TH>Age</TH>
                      <TH align="right">Action</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {active.map((row) => (
                      <TR key={row.id}>
                        <TD>
                          <ModeBadge mode={row.mode} />
                        </TD>
                        <TD mono>
                          {row.scope}
                          {row.target !== null ? `=${row.target}` : ''}
                        </TD>
                        <TD truncate>{row.reason}</TD>
                        <TD mono muted>
                          {ageString(row.pausedAt)}
                        </TD>
                        <TD align="right">
                          <form action={resumeAction} className="inline-flex">
                            <input type="hidden" name="id" value={row.id} />
                            <Button type="submit" size="sm" variant="ghost" leftIcon={<PlayIcon className="h-3 w-3" />}>
                              Resume
                            </Button>
                          </form>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </Section>
          </Card>

          <Card size="md">
            <Section
              title={
                <>
                  Recent <em>history</em>
                </>
              }
              count="last 24h"
              compact
            >
              {active.length === 0 ? (
                <EmptyState
                  size="md"
                  title={
                    <>
                      No <em>recent</em> switches
                    </>
                  }
                  body="Resume events from the past 24 hours will appear here once any kill switches engage."
                />
              ) : (
                <div className="flex flex-col gap-1.5">
                  {active.slice(0, 4).map((row) => (
                    <EventRow
                      key={`hist-${row.id}`}
                      time={ageString(row.pausedAt)}
                      tool={
                        <>
                          {row.mode} · <b>scope {row.scope}</b>{' '}
                          {row.target !== null ? <span className="text-text-tertiary">· {row.target}</span> : null}
                        </>
                      }
                      verdict="ACTIVE"
                      verdictTone={row.mode === 'hard' ? 'deny' : 'warn'}
                      dot={row.mode === 'hard' ? 'warn' : 'white'}
                    />
                  ))}
                </div>
              )}
            </Section>
          </Card>
        </div>
      </div>
    </PageShell>
  );
}

/* ───────────────────────── Subcomponents ───────────────────────── */

function FieldRow({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-text-muted">{label}</span>
      {children}
      {hint !== undefined ? <p className="font-mono text-[10px] tracking-[0.05em] text-text-muted">{hint}</p> : null}
    </div>
  );
}

function ModeBadge({ mode }: { readonly mode: string }) {
  return (
    <StatPill tone={mode === 'hard' ? 'warn' : 'caution'} dot>
      {mode}
    </StatPill>
  );
}

function Banners(sp: SearchParams) {
  if (sp.paused === undefined && sp.resumed === undefined && sp.duplicate === undefined && sp.error === undefined) {
    return null;
  }
  return (
    <div className="mb-6 flex flex-col gap-2">
      {sp.paused !== undefined ? (
        <Banner kind="success">
          Paused · id <span className="font-mono">{sp.paused}</span>.
        </Banner>
      ) : null}
      {sp.resumed !== undefined ? (
        <Banner kind="info">
          Resumed · id <span className="font-mono">{sp.resumed}</span>.
        </Banner>
      ) : null}
      {sp.duplicate !== undefined ? (
        <Banner kind="warning">
          This scope is already paused · id <span className="font-mono">{sp.duplicate}</span>. Submit again with force
          to add a second switch (first-match-wins keeps the existing one in effect).
        </Banner>
      ) : null}
      {sp.error !== undefined ? <Banner kind="error">{sp.error}</Banner> : null}
    </div>
  );
}

function ageString(pausedAt: Date): string {
  const ms = Date.now() - pausedAt.getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
