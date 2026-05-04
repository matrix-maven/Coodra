import { notFound } from 'next/navigation';
import { StatusChip } from '@/components/StatusChip';
import { ToolBadge } from '@/components/ToolBadge';
import {
  Banner,
  Breadcrumbs,
  Button,
  Card,
  type Crumb,
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
import { addRuleAction, setActiveAction } from '@/lib/actions/policies';
import { resolveProjectFromParams } from '@/lib/project-context';
import { getPolicy } from '@/lib/queries/policies';

/**
 * `/projects/[slug]/policies/[id]` — server-rendered policy detail
 * (M04 Phase 2 S2a IA migration; restyled in Phase 2 UI). 404s if
 * the policy doesn't belong to the URL-bound project.
 */
export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly added?: string;
  readonly toggled?: string;
  readonly error?: string;
}

const DECISION_KIND_MAP: Record<string, 'success' | 'warning' | 'error'> = {
  allow: 'success',
  ask: 'warning',
  deny: 'error',
};

const DECISION_OPTIONS = ['deny', 'allow', 'ask'] as const;
const EVENT_OPTIONS = ['PreToolUse', 'PostToolUse'] as const;

export default async function PolicyDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const project = await resolveProjectFromParams(params);
  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);
  const sp = await searchParams;
  const policy = await getPolicy(id);
  if (policy === null) notFound();
  if (policy.projectId !== project.id) notFound();

  const baseHref = `/projects/${encodeURIComponent(project.slug)}`;
  const trail: ReadonlyArray<Crumb> = [
    { label: 'Projects', href: '/' },
    { label: project.slug, href: baseHref, mono: true },
    { label: 'Policies', href: `${baseHref}/policies` },
    { label: policy.name, mono: true },
  ];

  return (
    <PageShell>
      <Breadcrumbs trail={trail} />
      <PageHeader
        eyebrow="Policy"
        title={policy.name}
        actions={
          <StatusChip status={policy.isActive ? 'success' : 'neutral'}>
            {policy.isActive ? 'active' : 'inactive'}
          </StatusChip>
        }
        subtitle={
          <>
            {policy.description ?? 'Bridge-evaluated PreToolUse rules.'} Updated{' '}
            <span className="font-mono">{policy.updatedAt.toISOString().slice(0, 19).replace('T', ' ')}</span>.
          </>
        }
      />

      <Card size="sm">
        <dl className="grid grid-cols-1 gap-2 text-sm md:grid-cols-2">
          <Field label="ID" value={<span className="break-all font-mono text-xs">{policy.id}</span>} />
          <Field label="Project" value={<span className="break-all font-mono text-xs">{policy.projectId}</span>} />
        </dl>
      </Card>

      {sp.added !== undefined ? (
        <Banner kind="success">
          Rule added (id <span className="font-mono">{sp.added}</span>). Bridges will see it on the next cache miss
          (≤60s).
        </Banner>
      ) : null}
      {sp.toggled !== undefined ? (
        <Banner kind="info">Policy {sp.toggled}. Bridges apply on next 60s cache miss.</Banner>
      ) : null}
      {sp.error !== undefined ? <Banner kind="error">{sp.error}</Banner> : null}

      <Section title={`Rules (${policy.rules.length})`}>
        {policy.rules.length === 0 ? (
          <EmptyState title="No rules" body="Use the form below to add one." />
        ) : (
          <Table>
            <THead>
              <TR hoverable={false}>
                <TH align="right" width="64px">
                  Pri ↑
                </TH>
                <TH>Decision</TH>
                <TH>Event</TH>
                <TH>Tool</TH>
                <TH>Path glob</TH>
                <TH>Agent</TH>
                <TH>Reason</TH>
              </TR>
            </THead>
            <TBody>
              {policy.rules.map((rule) => (
                <TR key={rule.id}>
                  <TD align="right" mono>
                    {rule.priority}
                  </TD>
                  <TD>
                    <StatusChip status={DECISION_KIND_MAP[rule.decision] ?? 'neutral'}>{rule.decision}</StatusChip>
                  </TD>
                  <TD mono muted>
                    {rule.matchEventType}
                  </TD>
                  <TD>
                    <ToolBadge name={rule.matchToolName} />
                  </TD>
                  <TD mono>{rule.matchPathGlob ?? '—'}</TD>
                  <TD mono muted>
                    {rule.matchAgentType ?? '*'}
                  </TD>
                  <TD truncate>{rule.reason}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Section>

      <Section title="Add rule">
        <Card size="md">
          <form action={addRuleAction} className="grid gap-4 md:grid-cols-2">
            <input type="hidden" name="projectId" value={policy.projectId} />
            <input type="hidden" name="policyName" value={policy.name} />
            <input type="hidden" name="returnTo" value={policy.name} />
            <FormRow inputId="rule-tool" label="Tool name" required>
              <Input id="rule-tool" name="matchToolName" required mono placeholder="Edit" />
            </FormRow>
            <FormRow inputId="rule-decision" label="Decision" required>
              <Select id="rule-decision" name="decision" mono required>
                {DECISION_OPTIONS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </Select>
            </FormRow>
            <FormRow inputId="rule-glob" label="Path glob">
              <Input id="rule-glob" name="matchPathGlob" mono placeholder="**/forbidden/**" />
            </FormRow>
            <FormRow inputId="rule-agent" label="Agent type">
              <Input id="rule-agent" name="matchAgentType" mono placeholder="* (any)" />
            </FormRow>
            <FormRow inputId="rule-event" label="Event type">
              <Select id="rule-event" name="matchEventType" mono>
                {EVENT_OPTIONS.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </Select>
            </FormRow>
            <FormRow inputId="rule-priority" label="Priority">
              <Input id="rule-priority" name="priority" mono placeholder="auto (max + 10)" />
            </FormRow>
            <div className="md:col-span-2">
              <FormRow inputId="rule-reason" label="Reason" required>
                <Textarea
                  id="rule-reason"
                  name="reason"
                  required
                  placeholder="why this rule exists — operator audit context"
                  rows={3}
                />
              </FormRow>
            </div>
            <div className="md:col-span-2">
              <Button type="submit" variant="primary">
                Add rule
              </Button>
            </div>
            <p className="text-xs text-text-tertiary md:col-span-2">
              Bridge cache TTL is 60s. New rules visible to running bridges on the next cache miss.
            </p>
          </form>
        </Card>
      </Section>

      <Section title={policy.isActive ? 'Disable policy' : 'Enable policy'}>
        <Card size="md" tone={policy.isActive ? 'danger' : 'default'}>
          <form action={setActiveAction} className="flex flex-col gap-3">
            <input type="hidden" name="identifier" value={policy.id} />
            <input type="hidden" name="active" value={policy.isActive ? 'false' : 'true'} />
            <p className="text-sm text-text-secondary">
              {policy.isActive
                ? `Disabling ${policy.name} stops all ${policy.rules.length} of its rules from applying within ~60s.`
                : `Enabling ${policy.name} resumes all ${policy.rules.length} of its rules within ~60s.`}
            </p>
            <Button type="submit" variant={policy.isActive ? 'destructive' : 'primary'}>
              {policy.isActive ? 'Disable' : 'Enable'}
            </Button>
          </form>
        </Card>
      </Section>
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
