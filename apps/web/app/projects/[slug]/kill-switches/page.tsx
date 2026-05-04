import { StatusChip } from '@/components/StatusChip';
import {
  Banner,
  Button,
  Card,
  EmptyState,
  FormRow,
  Input,
  PageHeader,
  PageShell,
  Section,
  Select,
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
 * `/projects/[slug]/kill-switches` — server-rendered admin per
 * `docs/feature-packs/04-web-app/wireframes/02-screens/kill-switches.md`,
 * project-scoped UI per the M04 Phase 2 S2a IA migration; restyled
 * in Phase 2 UI.
 */
export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly paused?: string;
  readonly resumed?: string;
  readonly duplicate?: string;
  readonly scope?: string;
  readonly target?: string;
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

  return (
    <PageShell>
      <PageHeader
        eyebrow="Project · enforcement"
        title="Kill switches"
        subtitle={
          <>
            Pause and resume agent enforcement at four scopes: global, project, tool, agent type. Hard mode denies on
            match; soft mode allows + audits.
            <br />
            <span className="text-text-tertiary">
              {actor.mode === 'team'
                ? 'Pauses propagate to all developers within ~10s (sync-daemon pulls every 5s, bridge cache TTL 5s).'
                : 'Solo mode — pause is local only. No cross-developer propagation.'}
            </span>
          </>
        }
      />

      <Banners {...sp} />

      <Section title="Active" count={active.length}>
        {active.length === 0 ? (
          <EmptyState title="No active kill switches" body="Bridge enforcement is unrestricted." />
        ) : (
          <Table>
            <THead>
              <TR hoverable={false}>
                <TH>Mode</TH>
                <TH>Scope</TH>
                <TH>Reason</TH>
                <TH>Age</TH>
                <TH>Paused by</TH>
                <TH align="right">Action</TH>
              </TR>
            </THead>
            <TBody>
              {active.map((row) => (
                <TR key={row.id}>
                  <TD>
                    <StatusChip status={row.mode === 'hard' ? 'error' : 'warning'}>{row.mode}</StatusChip>
                  </TD>
                  <TD mono>
                    {row.scope}
                    {row.target !== null ? `=${row.target}` : ''}
                  </TD>
                  <TD truncate>{row.reason}</TD>
                  <TD mono muted>
                    {ageString(row.pausedAt)}
                  </TD>
                  <TD mono muted>
                    {row.pausedBySessionId ?? '—'}
                  </TD>
                  <TD align="right">
                    <form action={resumeAction} className="inline-flex">
                      <input type="hidden" name="id" value={row.id} />
                      <Button type="submit" size="sm" variant="secondary">
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

      <Section
        title="Pause new"
        subtitle={
          <>
            Pre-filled for project <span className="font-mono">{project.slug}</span>. Change scope/target to widen
            (global / tool / agent_type).
          </>
        }
      >
        <Card size="md" tone="danger">
          <PauseForm
            {...(sp.duplicate !== undefined ? { dupId: sp.duplicate } : {})}
            dupScope={sp.scope ?? 'project'}
            dupTarget={sp.target ?? project.slug}
          />
        </Card>
      </Section>
    </PageShell>
  );
}

function Banners(sp: SearchParams) {
  if (sp.paused === undefined && sp.resumed === undefined && sp.duplicate === undefined && sp.error === undefined) {
    return null;
  }
  return (
    <div className="flex flex-col gap-2">
      {sp.paused !== undefined ? (
        <Banner kind="success">
          Paused (id <span className="font-mono">{sp.paused}</span>).
        </Banner>
      ) : null}
      {sp.resumed !== undefined ? (
        <Banner kind="info">
          Resumed (id <span className="font-mono">{sp.resumed}</span>).
        </Banner>
      ) : null}
      {sp.duplicate !== undefined ? (
        <Banner kind="warning">
          This scope is already paused — id <span className="font-mono">{sp.duplicate}</span>. Submit again with the
          force flag below to add a second active switch (the matcher's first-match-wins keeps the existing one in
          effect until resumed).
        </Banner>
      ) : null}
      {sp.error !== undefined ? <Banner kind="error">{sp.error}</Banner> : null}
    </div>
  );
}

function PauseForm({
  dupId,
  dupScope,
  dupTarget,
}: {
  readonly dupId?: string;
  readonly dupScope?: string;
  readonly dupTarget?: string;
}) {
  return (
    <form action={pauseAction} className="grid gap-4 md:grid-cols-2">
      <FormRow inputId="kill-scope" label="Scope" required>
        <Select id="kill-scope" name="scope" defaultValue={dupScope ?? 'global'} mono required>
          {SCOPES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
      </FormRow>
      <FormRow inputId="kill-target" label="Target (required for non-global)">
        <Input
          id="kill-target"
          name="target"
          mono
          placeholder="Bash | my-project | claude_code"
          defaultValue={dupTarget ?? ''}
        />
      </FormRow>
      <FormRow inputId="kill-mode" label="Mode" required>
        <Select id="kill-mode" name="mode" defaultValue="hard" mono required>
          {MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </Select>
      </FormRow>
      <FormRow inputId="kill-expires" label="Expires at (optional)">
        <Input id="kill-expires" name="expiresAt" mono placeholder="ISO 8601 (e.g. 2026-05-04T22:00:00Z)" />
      </FormRow>
      <div className="md:col-span-2">
        <FormRow inputId="kill-reason" label="Reason" required>
          <Textarea
            id="kill-reason"
            name="reason"
            required
            placeholder="why this kill switch — operator audit context"
            rows={3}
          />
        </FormRow>
      </div>
      {dupId !== undefined ? <input type="hidden" name="force" value="true" /> : null}
      <div className="md:col-span-2">
        <Button type="submit" variant="destructive">
          {dupId !== undefined ? 'Pause anyway' : 'Pause'}
        </Button>
      </div>
    </form>
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
