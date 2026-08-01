import Link from 'next/link';

import { Topbar } from '@/components/Topbar';
import { addRuleAction, deleteRuleAction, saveWorkflowPolicyAction, setActiveAction } from '@/lib/actions/policies';
import { listPolicies } from '@/lib/queries/policies';
import { getProject, listProjects } from '@/lib/queries/projects';
import { listWorkflowPolicies } from '@/lib/queries/workflow-policy';

export const dynamic = 'force-dynamic';

export default async function PoliciesPage({
  searchParams,
}: {
  searchParams: Promise<{ added?: string; toggled?: string; error?: string; project?: string; deleted?: string }>;
}) {
  const sp = await searchParams;
  const projects = await listProjects();
  const scopedProject = sp.project !== undefined && sp.project !== '' ? await getProject(sp.project) : null;
  const policies = await listPolicies(scopedProject?.id ?? null);
  const workflowPolicies = await listWorkflowPolicies(scopedProject !== null ? [scopedProject] : projects);
  // Map projectId → slug for the chip list when grouping.
  const projectSlugById = new Map(projects.map((p) => [p.id, p.slug]));
  // Flatten into rows: each rule is a row, with policy + project context.
  const flatRows = policies.flatMap((p) =>
    p.rules.map((r) => ({
      ruleId: r.id,
      policyName: p.name,
      policyId: p.id,
      projectId: p.projectId,
      decision: r.decision,
      matchEventType: r.matchEventType,
      matchToolName: r.matchToolName,
      matchPathGlob: r.matchPathGlob,
      reason: r.reason,
      priority: r.priority,
      active: p.isActive,
    })),
  );

  // When NO project is scoped, collapse rules with identical signatures
  // across projects — most users seed `coodra init` with the bundled
  // 25-rule chain, which then fans out to 25*N policy_rules rows. Showing
  // the signature once with a "applies to N projects" chip list is the
  // honest summary; the per-project view is one click away.
  const groupedRows: ReadonlyArray<GroupedRule> =
    scopedProject !== null
      ? flatRows.map((r) => ({
          signature: r.ruleId,
          decision: r.decision,
          matchEventType: r.matchEventType,
          matchToolName: r.matchToolName,
          matchPathGlob: r.matchPathGlob,
          reason: r.reason,
          priority: r.priority,
          appliesTo: [{ projectId: r.projectId, slug: projectSlugById.get(r.projectId) ?? r.projectId.slice(0, 8) }],
          ruleIds: [r.ruleId],
        }))
      : groupBySignature(flatRows, projectSlugById);

  const totalRules = flatRows.length;
  const totalPolicies = policies.length;
  const groupedView = scopedProject === null && groupedRows.length < flatRows.length;

  return (
    <>
      <Topbar crumb="Policies" crumbPrefix={scopedProject !== null ? `coodra / ${scopedProject.slug}` : 'coodra'} />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">
              /03 · GOVERN · POLICIES
              {scopedProject !== null ? ` · ${scopedProject.slug.toUpperCase()}` : ''}
            </div>
            <h1 className="head__title">
              <em>Policies</em>, by the rule.
            </h1>
            <p className="head__lede">
              Deny lists are loud, allow lists are quiet. Every tool call passes through the chain in order; first match
              wins.
              {scopedProject !== null ? (
                <>
                  {' Scoped to '}
                  <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>{scopedProject.slug}</span>
                  {' — '}
                  <Link href="/policies" style={{ textDecoration: 'underline', color: 'var(--ink-dim)' }}>
                    show all
                  </Link>
                  .
                </>
              ) : null}
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>{totalRules} rules</strong>
              <br />
              {groupedView ? (
                <>
                  {groupedRows.length} unique · <em style={{ color: 'var(--ink-dim)' }}>collapsed</em>
                </>
              ) : (
                <>
                  {totalPolicies} {totalPolicies === 1 ? 'policy' : 'policies'}
                </>
              )}
              <br />
              {scopedProject !== null ? scopedProject.slug : 'all projects'}
            </div>
          </div>
        </div>

        {sp.added !== undefined ? <Banner tone="ok">Rule added · {sp.added.slice(0, 8)}</Banner> : null}
        {sp.toggled !== undefined ? <Banner tone="ok">Policy {sp.toggled}</Banner> : null}
        {sp.deleted !== undefined ? <Banner tone="ok">Rule deleted · {sp.deleted}</Banner> : null}
        {sp.error !== undefined ? <Banner tone="warn">Error: {sp.error}</Banner> : null}

        <div style={{ marginBottom: 24 }}>
          <div className="card__head" style={{ marginBottom: 14 }}>
            <h2 className="card__title">
              Workflow <em>policy</em>
            </h2>
            <span className="card__role">agent governance · .coodra/config.json</span>
          </div>
          <div className="dash-grid">
            {workflowPolicies.map((item) => (
              <form
                key={item.projectId}
                action={saveWorkflowPolicyAction}
                className="aside-card"
                style={{ margin: 0, minWidth: 0 }}
              >
                <input type="hidden" name="projectSlug" value={item.projectSlug} />
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 16 }}>
                  <div>
                    <div style={{ fontFamily: 'var(--serif)', fontSize: 22 }}>{item.projectSlug}</div>
                    <div
                      style={{
                        fontFamily: 'var(--mono)',
                        fontSize: 10,
                        color: item.exists ? 'var(--accent)' : 'var(--warn)',
                        letterSpacing: '0.06em',
                        marginTop: 4,
                      }}
                    >
                      {item.exists ? item.policy.profile : 'config missing'}
                    </div>
                  </div>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontFamily: 'var(--mono)',
                      fontSize: 10,
                      color: 'var(--ink-dim)',
                    }}
                  >
                    <input type="checkbox" name="enabled" defaultChecked={item.policy.enabled} />
                    enabled
                  </label>
                </div>

                {item.error !== null ? (
                  <div style={{ marginTop: 12, color: 'var(--warn)', fontSize: 12 }}>{item.error}</div>
                ) : null}

                <div className="field" style={{ marginTop: 18, marginBottom: 14 }}>
                  <label
                    htmlFor={`workflow-profile-${item.projectId}`}
                    className="field__label"
                    style={fieldLabelStyle}
                  >
                    Profile
                  </label>
                  <select
                    id={`workflow-profile-${item.projectId}`}
                    name="profile"
                    defaultValue={item.policy.profile}
                    style={fieldInputStyle}
                  >
                    <option value="solo">solo</option>
                    <option value="team">team</option>
                    <option value="manual">manual</option>
                  </select>
                </div>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                    gap: 10,
                    marginBottom: 18,
                  }}
                >
                  <Check name="requireBranch" label="branch first" checked={item.policy.requireBranch} />
                  <Check name="requireDecisionLog" label="decision log" checked={item.policy.requireDecisionLog} />
                  <Check name="requireContextPack" label="context pack" checked={item.policy.requireContextPack} />
                  <Check name="requireTests" label="tests" checked={item.policy.requireTests} />
                  <Check name="requireCommit" label="commit" checked={item.policy.requireCommit} />
                  <Check name="requirePush" label="push" checked={item.policy.requirePush} />
                  <Check name="requirePrLink" label="PR link" checked={item.policy.requirePrLink} />
                  <Check name="allowAutoMerge" label="auto-merge" checked={item.policy.allowAutoMerge} />
                  <Check
                    name="updateWorkPackOnCompletion"
                    label="update work pack"
                    checked={item.policy.updateWorkPackOnCompletion}
                  />
                </div>

                <button className="btn btn--accent" type="submit">
                  Save workflow policy
                </button>
              </form>
            ))}
          </div>
        </div>

        <div className="card" style={{ padding: 28, marginBottom: 24 }}>
          <div className="card__head">
            <h2 className="card__title">
              Rule <em>chain</em>
            </h2>
            <span className="card__role">
              {groupedView
                ? `unique signatures · ${groupedRows.length} of ${totalRules} rules · scope a project to expand`
                : 'priority · top to bottom'}
            </span>
          </div>
          {groupedRows.length === 0 ? (
            <div className="empty">
              <strong>
                No rules <em>yet</em>.
              </strong>
              Add one below or run{' '}
              <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>coodra init</span> to seed the default
              chain.
            </div>
          ) : (
            <>
              <div
                className="policy-row"
                style={{
                  background: 'transparent',
                  border: 'none',
                  borderBottom: '1px solid var(--rule)',
                  paddingLeft: 0,
                  paddingRight: 0,
                  color: 'var(--ink-mute)',
                  fontSize: 9,
                  letterSpacing: '0.2em',
                  textTransform: 'uppercase',
                  fontWeight: 500,
                }}
              >
                <div>Verdict</div>
                <div>Tool · path</div>
                <div>Reason</div>
                <div>{groupedView ? 'Applies to' : 'Policy'}</div>
                <div style={{ textAlign: 'right' }}>Priority</div>
              </div>
              {groupedRows.map((row) => (
                <div key={row.signature} className="policy-row">
                  <div
                    className="policy-row__verdict"
                    style={{
                      color:
                        row.decision === 'deny'
                          ? 'var(--warn)'
                          : row.decision === 'ask'
                            ? 'var(--caution)'
                            : 'var(--accent)',
                    }}
                  >
                    {row.decision.toUpperCase()}
                  </div>
                  <div className="policy-row__pattern">
                    {row.matchToolName}
                    {row.matchPathGlob !== null ? ` · ${row.matchPathGlob}` : ''}
                  </div>
                  <div className="policy-row__reason">{row.reason}</div>
                  <div
                    style={{
                      fontFamily: 'var(--mono)',
                      fontSize: 10,
                      color: 'var(--ink-dim)',
                      letterSpacing: '0.04em',
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 4,
                    }}
                  >
                    {groupedView ? (
                      row.appliesTo.length === projects.length ? (
                        <span style={{ color: 'var(--accent)' }}>all {row.appliesTo.length} projects</span>
                      ) : row.appliesTo.length > 4 ? (
                        <span title={row.appliesTo.map((a) => a.slug).join(', ')}>{row.appliesTo.length} projects</span>
                      ) : (
                        row.appliesTo.map((a) => (
                          <Link
                            key={a.projectId}
                            href={`/policies?project=${encodeURIComponent(a.slug)}`}
                            style={{ color: 'var(--ink-dim)', textDecoration: 'none' }}
                          >
                            {a.slug}
                          </Link>
                        ))
                      )
                    ) : (
                      (row.appliesTo[0]?.slug ?? '—')
                    )}
                  </div>
                  <div
                    className="policy-row__hits"
                    style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'flex-end' }}
                  >
                    <span>{row.priority}</span>
                    {/* Delete is only available on the per-project view —
                        the grouped view spans N rule rows across N projects,
                        and silently deleting all N from one click is too
                        destructive. Drill into the project to delete. */}
                    {!groupedView && row.ruleIds[0] !== undefined ? (
                      <form action={deleteRuleAction} style={{ display: 'inline' }}>
                        <input type="hidden" name="ruleId" value={row.ruleIds[0]} />
                        <input
                          type="hidden"
                          name="returnTo"
                          value={
                            scopedProject !== null
                              ? `/policies?project=${encodeURIComponent(scopedProject.slug)}`
                              : '/policies'
                          }
                        />
                        <button
                          type="submit"
                          title={`Delete rule (${row.ruleIds[0].slice(0, 8)}) — applies immediately, no undo`}
                          style={{
                            background: 'transparent',
                            border: '1px solid var(--rule-strong)',
                            color: 'var(--ink-mute)',
                            fontFamily: 'var(--mono)',
                            fontSize: 9,
                            letterSpacing: '0.18em',
                            textTransform: 'uppercase',
                            padding: '4px 8px',
                            cursor: 'pointer',
                          }}
                        >
                          ×
                        </button>
                      </form>
                    ) : null}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        <div className="dash-grid">
          <div className="aside-card">
            <h3 className="aside-card__title" style={{ marginBottom: 14 }}>
              Add a <em>rule</em>
            </h3>
            <form action={addRuleAction}>
              {projects.length > 1 ? (
                <div className="field" style={{ marginBottom: 14 }}>
                  <label htmlFor="policy-project" className="field__label" style={fieldLabelStyle}>
                    Project
                  </label>
                  <select
                    id="policy-project"
                    name="projectId"
                    defaultValue={projects[0]?.id ?? ''}
                    style={fieldInputStyle}
                    required
                  >
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.slug}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <input type="hidden" name="projectId" value={projects[0]?.id ?? '__global__'} />
              )}
              <Field label="Tool name" name="matchToolName" placeholder="edit · read · bash" required />
              <Field label="Path glob (optional)" name="matchPathGlob" placeholder="prod/.env" />
              <SelectField label="Decision" name="decision" options={['deny', 'allow', 'ask']} />
              <Field label="Reason" name="reason" placeholder="Production secrets — never edit." required textarea />
              <Field label="Priority (optional)" name="priority" placeholder="100" />
              <button className="btn btn--accent" style={{ width: '100%' }} type="submit">
                Add rule
              </button>
            </form>
          </div>

          <div className="aside-card">
            <h3 className="aside-card__title" style={{ marginBottom: 14 }}>
              Active <em>policies</em>
            </h3>
            {policies.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--ink-dim)' }}>None.</div>
            ) : (
              policies.map((p) => (
                <form
                  key={p.id}
                  action={setActiveAction}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '14px 0',
                    borderBottom: '1px solid var(--rule)',
                    gap: 12,
                  }}
                >
                  <div>
                    <div style={{ fontFamily: 'var(--serif)', fontSize: 18 }}>{p.name}</div>
                    <div
                      style={{
                        fontFamily: 'var(--mono)',
                        fontSize: 10,
                        color: 'var(--ink-mute)',
                        letterSpacing: '0.06em',
                        marginTop: 3,
                      }}
                    >
                      {p.rules.length} rules · {p.id.slice(0, 8)}
                    </div>
                  </div>
                  <input type="hidden" name="identifier" value={p.id} />
                  <input type="hidden" name="active" value={p.isActive ? 'false' : 'true'} />
                  <button className={`badge ${p.isActive ? 'badge--ok' : ''}`} type="submit">
                    <span className="badge__dot"></span>
                    {p.isActive ? 'ON' : 'OFF'}
                  </button>
                </form>
              ))
            )}
          </div>
        </div>
      </section>
    </>
  );
}

function Banner({ children, tone }: { children: React.ReactNode; tone: 'ok' | 'warn' }) {
  return (
    <div
      style={{
        padding: '12px 16px',
        marginBottom: 24,
        border: `1px solid ${tone === 'warn' ? 'var(--warn)' : 'var(--accent)'}`,
        background: tone === 'warn' ? 'var(--warn-glow)' : 'var(--accent-glow)',
        fontFamily: 'var(--mono)',
        fontSize: 11,
        color: tone === 'warn' ? 'var(--warn)' : 'var(--accent)',
        letterSpacing: '0.08em',
      }}
    >
      {children}
    </div>
  );
}

function Field({
  label,
  name,
  placeholder,
  required,
  textarea,
}: {
  label: string;
  name: string;
  placeholder?: string;
  required?: boolean;
  textarea?: boolean;
}) {
  const fieldId = `policy-field-${name}`;
  return (
    <div className="field" style={{ marginBottom: 14 }}>
      <label
        htmlFor={fieldId}
        className="field__label"
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 9,
          letterSpacing: '0.2em',
          textTransform: 'uppercase',
          color: 'var(--ink-mute)',
          marginBottom: 6,
          display: 'block',
        }}
      >
        {label}
      </label>
      {textarea ? (
        <textarea
          id={fieldId}
          name={name}
          placeholder={placeholder}
          required={required}
          style={fieldInputStyle}
          rows={2}
        />
      ) : (
        <input id={fieldId} name={name} placeholder={placeholder} required={required} style={fieldInputStyle} />
      )}
    </div>
  );
}

function SelectField({ label, name, options }: { label: string; name: string; options: ReadonlyArray<string> }) {
  const selectId = `policy-select-${name}`;
  return (
    <div className="field" style={{ marginBottom: 14 }}>
      <label htmlFor={selectId} className="field__label" style={fieldLabelStyle}>
        {label}
      </label>
      <select id={selectId} name={name} style={fieldInputStyle}>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}

function Check({ name, label, checked }: { name: string; label: string; checked: boolean }) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        minHeight: 32,
        fontFamily: 'var(--mono)',
        fontSize: 11,
        color: 'var(--ink-dim)',
        border: '1px solid var(--rule)',
        padding: '6px 8px',
      }}
    >
      <input type="checkbox" name={name} defaultChecked={checked} />
      {label}
    </label>
  );
}

const fieldLabelStyle: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 9,
  letterSpacing: '0.2em',
  textTransform: 'uppercase',
  color: 'var(--ink-mute)',
  marginBottom: 6,
  display: 'block',
};

const fieldInputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  background: 'var(--bg)',
  border: '1px solid var(--rule-strong)',
  color: 'var(--ink)',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  letterSpacing: '0.04em',
};

// ---------------------------------------------------------------------------
// Rule grouping by signature
// ---------------------------------------------------------------------------

interface FlatRuleRow {
  readonly ruleId: string;
  readonly projectId: string;
  readonly decision: string;
  readonly matchEventType: string;
  readonly matchToolName: string;
  readonly matchPathGlob: string | null;
  readonly reason: string;
  readonly priority: number;
}

interface GroupedRule {
  readonly signature: string;
  readonly decision: string;
  readonly matchEventType: string;
  readonly matchToolName: string;
  readonly matchPathGlob: string | null;
  readonly reason: string;
  readonly priority: number;
  readonly appliesTo: ReadonlyArray<{ readonly projectId: string; readonly slug: string }>;
  readonly ruleIds: ReadonlyArray<string>;
}

/**
 * Collapse rules with identical (decision, eventType, toolName, pathGlob, reason)
 * across projects. Same `coodra init` baseline fans out to N copies of
 * each rule — showing the signature once with a project chip list is the
 * honest summary. Sorted by (priority ASC, decision DESC) so the densest
 * deny rules surface first.
 */
function groupBySignature(
  rows: ReadonlyArray<FlatRuleRow>,
  projectSlugById: Map<string, string>,
): ReadonlyArray<GroupedRule> {
  const map = new Map<
    string,
    GroupedRule & { readonly _appliesTo: Map<string, { projectId: string; slug: string }> }
  >();
  for (const r of rows) {
    const sig = `${r.matchEventType}|${r.matchToolName}|${r.matchPathGlob ?? '_'}|${r.decision}|${r.reason}`;
    let entry = map.get(sig);
    if (entry === undefined) {
      const seed = {
        signature: sig,
        decision: r.decision,
        matchEventType: r.matchEventType,
        matchToolName: r.matchToolName,
        matchPathGlob: r.matchPathGlob,
        reason: r.reason,
        priority: r.priority,
        appliesTo: [],
        ruleIds: [],
        _appliesTo: new Map<string, { projectId: string; slug: string }>(),
      };
      entry = seed as unknown as GroupedRule & {
        readonly _appliesTo: Map<string, { projectId: string; slug: string }>;
      };
      map.set(sig, entry);
    }
    if (!entry._appliesTo.has(r.projectId)) {
      entry._appliesTo.set(r.projectId, {
        projectId: r.projectId,
        slug: projectSlugById.get(r.projectId) ?? r.projectId.slice(0, 8),
      });
    }
    (entry.ruleIds as string[]).push(r.ruleId);
  }
  const result: GroupedRule[] = [];
  for (const entry of map.values()) {
    const appliesTo = [...entry._appliesTo.values()].sort((a, b) => a.slug.localeCompare(b.slug));
    result.push({
      signature: entry.signature,
      decision: entry.decision,
      matchEventType: entry.matchEventType,
      matchToolName: entry.matchToolName,
      matchPathGlob: entry.matchPathGlob,
      reason: entry.reason,
      priority: entry.priority,
      appliesTo,
      ruleIds: entry.ruleIds,
    });
  }
  // Sort: priority ASC (lower = earlier in chain), then deny > ask > allow.
  result.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const decRank = (d: string) => (d === 'deny' ? 0 : d === 'ask' ? 1 : 2);
    return decRank(a.decision) - decRank(b.decision);
  });
  return result;
}
