import { StatusChip } from '@/components/StatusChip';
import {
  EmptyState,
  LinkButton,
  PageHeader,
  PageShell,
  Section,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@/components/ui';
import { resolveProjectFromParams } from '@/lib/project-context';
import { listPolicies } from '@/lib/queries/policies';

/**
 * `/projects/[slug]/policies` — editorial policy list (mirrors
 * brand-kit Policies, screen 06).
 */
export const dynamic = 'force-dynamic';

export default async function PoliciesListPage({ params }: { params: Promise<{ slug: string }> }) {
  const project = await resolveProjectFromParams(params);
  const policies = await listPolicies(project.id);
  const totalRules = policies.reduce((acc, p) => acc + p.rules.length, 0);

  return (
    <PageShell>
      <PageHeader
        eyebrow="/03 · GOVERN · POLICIES"
        title={
          <>
            <em>Policies</em>, by the rule.
          </>
        }
        subtitle={
          <>
            Deny lists are loud, allow lists are quiet. Every tool call passes through the chain in order; first match
            wins. Active rule sets are evaluated by the bridge before every PreToolUse on{' '}
            <span className="font-mono text-accent">{project.slug}</span>.
          </>
        }
        meta={
          <>
            <strong className="font-medium text-text-primary">__default__</strong>
            <br />
            {totalRules} rule{totalRules === 1 ? '' : 's'} · active
            <br />v 0.4.1
          </>
        }
        actions={
          <>
            <LinkButton href={`/projects/${encodeURIComponent(project.slug)}/policies`} variant="ghost">
              Test rule
            </LinkButton>
            <LinkButton href={`/projects/${encodeURIComponent(project.slug)}/policies`} variant="primary">
              Add rule
            </LinkButton>
          </>
        }
      />

      {policies.length === 0 ? (
        <EmptyState
          title={
            <>
              No <em>policies</em> on this project
            </>
          }
          body={
            <>
              Run <span className="font-mono text-accent">contextos init</span> in{' '}
              <span className="font-mono text-accent">{project.slug}</span> to seed the default policy set.
            </>
          }
        />
      ) : (
        <Section
          title={
            <>
              Rule <em>chain</em>
            </>
          }
          count={`${policies.length} · priority top → bottom`}
        >
          <Table>
            <THead>
              <TR hoverable={false}>
                <TH>Name</TH>
                <TH>Status</TH>
                <TH align="right">Rules</TH>
                <TH>Updated</TH>
                <TH align="right">Open</TH>
              </TR>
            </THead>
            <TBody>
              {policies.map((policy) => (
                <TR key={policy.id}>
                  <TD mono>{policy.name}</TD>
                  <TD>
                    <StatusChip status={policy.isActive ? 'success' : 'neutral'}>
                      {policy.isActive ? 'ACTIVE' : 'INACTIVE'}
                    </StatusChip>
                  </TD>
                  <TD align="right" mono>
                    {policy.rules.length}
                  </TD>
                  <TD mono muted>
                    {policy.updatedAt.toISOString().slice(0, 19).replace('T', ' ')}
                  </TD>
                  <TD align="right">
                    <LinkButton
                      href={`/projects/${encodeURIComponent(project.slug)}/policies/${encodeURIComponent(policy.id)}`}
                      variant="ghost"
                      size="sm"
                    >
                      Open
                    </LinkButton>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Section>
      )}
    </PageShell>
  );
}
