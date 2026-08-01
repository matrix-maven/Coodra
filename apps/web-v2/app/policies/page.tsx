import { getPolicyEvaluator, POLICY_EVALUATORS } from '@coodra/shared';
import Link from 'next/link';

import { Topbar } from '@/components/Topbar';
import {
  addRuleAction,
  deleteRuleAction,
  publishPolicyVersionAction,
  requestPolicyExceptionAction,
  setActiveAction,
  updatePolicyExceptionStatusAction,
  updateRuleAction,
} from '@/lib/actions/policies';
import { listPolicies, listPolicyExceptions, listPolicyVersions } from '@/lib/queries/policies';
import { getProject, listProjects } from '@/lib/queries/projects';

export const dynamic = 'force-dynamic';

const GROUP_LABELS: Readonly<Record<string, { title: string; description: string }>> = {
  agent_guardrails: {
    title: 'Agent Guardrails',
    description: 'Tool-call controls for file writes, shell commands, sensitive paths, and human confirmation.',
  },
  data_protection: {
    title: 'Data Protection',
    description: 'Controls for secrets, customer data, PII, approved model vendors, and data egress evidence.',
  },
  delivery_governance: {
    title: 'Delivery Governance',
    description: 'Workflow expectations such as branch-first work, tests, commits, PR links, and work-pack updates.',
  },
  change_control: {
    title: 'Change Control',
    description: 'Approval and audit requirements around risky changes, migrations, releases, and production edits.',
  },
  supply_chain: {
    title: 'Supply Chain',
    description: 'Package manager, dependency, install-script, and generated-vendor controls.',
  },
  separation_of_duties: {
    title: 'Separation of Duties',
    description: 'Approval boundaries for policy changes, exceptions, production actions, and author self-approval.',
  },
  ai_governance: {
    title: 'AI Governance',
    description: 'Model, prompt, data disclosure, context-sharing, and generated-output evidence controls.',
  },
  custom: {
    title: 'Custom Policies',
    description: 'Project-specific controls that do not fit a built-in governance group.',
  },
};

export default async function PoliciesPage({
  searchParams,
}: {
  searchParams: Promise<{ added?: string; toggled?: string; error?: string; project?: string; deleted?: string }>;
}) {
  const sp = await searchParams;
  const projects = await listProjects();
  const scopedProject = sp.project !== undefined && sp.project !== '' ? await getProject(sp.project) : null;
  const policies = await listPolicies(scopedProject?.id ?? null);
  const exceptions = await listPolicyExceptions(scopedProject?.id ?? null);
  const versionsByPolicy = new Map(
    await Promise.all(policies.map(async (policy) => [policy.id, await listPolicyVersions(policy.id)] as const)),
  );
  const projectSlugById = new Map(projects.map((p) => [p.id, p.slug]));
  const groupedPolicies = groupPolicies(policies);
  const totalRules = policies.reduce((sum, policy) => sum + policy.rules.length, 0);
  const activeExceptions = exceptions.filter((exception) => exception.status === 'active').length;

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
              Agent <em>governance</em>.
            </h1>
            <p className="head__lede">
              Policies are DB-backed controls. Versions preserve immutable snapshots, exceptions record approved drift,
              and agent config receives only managed projection metadata.
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
          <div className="head__meta">
            <strong>{policies.length} policies</strong>
            <br />
            {totalRules} rules
            <br />
            {activeExceptions} active exceptions
          </div>
        </div>

        {sp.added !== undefined ? <Banner tone="ok">Created · {sp.added}</Banner> : null}
        {sp.toggled !== undefined ? <Banner tone="ok">Updated · {sp.toggled}</Banner> : null}
        {sp.deleted !== undefined ? <Banner tone="ok">Deleted · {sp.deleted}</Banner> : null}
        {sp.error !== undefined ? <Banner tone="warn">Error: {sp.error}</Banner> : null}

        <div className="dash-grid" style={{ marginBottom: 24 }}>
          <Stat
            title="Policy Versions"
            value={String([...versionsByPolicy.values()].flat().length)}
            detail="immutable snapshots"
          />
          <Stat title="Ask Evidence" value="approved / unresolved" detail="PostToolUse correlation" />
          <Stat title="Config Projection" value="detective" detail="DB is source of truth" />
        </div>

        {groupedPolicies.length === 0 ? (
          <div className="empty">
            <strong>
              No policies <em>yet</em>.
            </strong>
            Run <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>coodra init</span> or add a rule
            below.
          </div>
        ) : (
          groupedPolicies.map(([groupKey, groupPoliciesForKey]) => {
            const group = GROUP_LABELS[groupKey] ?? {
              title: 'Custom Policies',
              description: 'Project-specific controls that do not fit a built-in governance group.',
            };
            return (
              <section key={groupKey} className="card" style={{ padding: 28, marginBottom: 24 }}>
                <div className="card__head">
                  <div>
                    <h2 className="card__title">
                      {group.title.split(' ')[0]} <em>{group.title.split(' ').slice(1).join(' ')}</em>
                    </h2>
                    <p style={{ color: 'var(--ink-dim)', margin: '6px 0 0', maxWidth: 780 }}>{group.description}</p>
                  </div>
                  <span className="card__role">{groupPoliciesForKey.length} policies</span>
                </div>

                {groupPoliciesForKey.map((policy) => {
                  const versions = versionsByPolicy.get(policy.id) ?? [];
                  const activeVersion = versions.find((version) => version.status === 'active') ?? versions[0] ?? null;
                  return (
                    <div key={policy.id} style={{ borderTop: '1px solid var(--rule)', paddingTop: 18, marginTop: 18 }}>
                      <div className="policy-row" style={{ border: 'none', padding: 0, background: 'transparent' }}>
                        <div>
                          <div style={{ fontFamily: 'var(--serif)', fontSize: 22 }}>{policy.name}</div>
                          <div style={monoDim}>
                            {projectSlugById.get(policy.projectId) ?? policy.projectId.slice(0, 8)} ·{' '}
                            {policy.enforcementMode} · {policy.profile}
                          </div>
                        </div>
                        <div style={monoDim}>{policy.description ?? 'No description'}</div>
                        <div style={monoDim}>
                          {activeVersion !== null ? (
                            <>
                              v{activeVersion.versionNumber} · {activeVersion.snapshotHash.slice(0, 18)}
                            </>
                          ) : (
                            'no version snapshot'
                          )}
                        </div>
                        <form action={setActiveAction} style={{ textAlign: 'right' }}>
                          <input type="hidden" name="identifier" value={policy.id} />
                          <input type="hidden" name="active" value={policy.isActive ? 'false' : 'true'} />
                          <button className={`badge ${policy.isActive ? 'badge--ok' : ''}`} type="submit">
                            <span className="badge__dot"></span>
                            {policy.isActive ? 'ON' : 'OFF'}
                          </button>
                        </form>
                        <form action={publishPolicyVersionAction} style={{ textAlign: 'right' }}>
                          <input type="hidden" name="policyId" value={policy.id} />
                          <input type="hidden" name="returnTo" value="/policies" />
                          <input type="hidden" name="changeSummary" value="Published from Policies UI" />
                          <button className="btn" type="submit" title="Create an immutable active version snapshot">
                            Publish version
                          </button>
                        </form>
                      </div>

                      <div style={{ marginTop: 18 }}>
                        {policy.rules.map((rule) => {
                          const evaluator = getPolicyEvaluator(rule.ruleType);
                          return (
                            <div key={rule.id} style={{ borderTop: '1px solid var(--rule)' }}>
                              <div className="policy-row" style={{ borderTop: 'none' }}>
                                <div className="policy-row__verdict" style={{ color: verdictColor(rule.decision) }}>
                                  {rule.decision.toUpperCase()}
                                </div>
                                <div className="policy-row__pattern">
                                  {rule.matchToolName}
                                  {rule.matchPathGlob !== null ? ` · ${rule.matchPathGlob}` : ''}
                                  {rule.matchCommandPattern !== null ? ` · ${rule.matchCommandPattern}` : ''}
                                  <div style={monoDim}>
                                    {evaluator.label} · {rule.matchEventType} · {rule.severity} ·{' '}
                                    {rule.controlKey ?? rule.ruleType}
                                  </div>
                                </div>
                                <div className="policy-row__reason">{rule.reason}</div>
                                <div style={monoDim}>{rule.details ?? 'No details'}</div>
                                <RemoveRuleControl ruleId={rule.id} />
                              </div>
                              <details style={{ padding: '0 0 16px 0' }}>
                                <summary style={editSummaryStyle}>edit rule</summary>
                                <form action={updateRuleAction} style={editRuleGridStyle}>
                                  <input type="hidden" name="ruleId" value={rule.id} />
                                  <SelectField
                                    label="Evaluator"
                                    name="evaluator"
                                    options={POLICY_EVALUATORS.map((entry) => `${entry.key}::${entry.label}`)}
                                    valueLabel={(value) => value.split('::')[1] ?? value}
                                    valueTransform={(value) => value.split('::')[0] ?? value}
                                    defaultValue={evaluator.key}
                                    help="Changing evaluator changes which matcher fields are meaningful."
                                  />
                                  <SelectField
                                    label="Event"
                                    name="matchEventType"
                                    options={[
                                      'PreToolUse',
                                      'PostToolUse',
                                      'Stop',
                                      'SubagentStop',
                                      'ConfigChange',
                                      'SessionStart',
                                      'SessionEnd',
                                    ]}
                                    defaultValue={rule.matchEventType}
                                  />
                                  <SelectField
                                    label="Decision"
                                    name="decision"
                                    options={['deny', 'ask', 'allow', 'block', 'flag', 'record', 'warn', 'pass']}
                                    defaultValue={rule.decision}
                                  />
                                  <Field label="Tool name" name="matchToolName" defaultValue={rule.matchToolName} />
                                  <Field
                                    label="Path glob"
                                    name="matchPathGlob"
                                    defaultValue={rule.matchPathGlob ?? ''}
                                  />
                                  <Field
                                    label="Command pattern"
                                    name="matchCommandPattern"
                                    defaultValue={rule.matchCommandPattern ?? ''}
                                  />
                                  <Field label="Control key" name="controlKey" defaultValue={rule.controlKey ?? ''} />
                                  <SelectField
                                    label="Severity"
                                    name="severity"
                                    options={['low', 'medium', 'high', 'critical']}
                                    defaultValue={rule.severity}
                                  />
                                  <Field label="Priority" name="priority" defaultValue={String(rule.priority)} />
                                  <Field
                                    label="Reason"
                                    name="reason"
                                    defaultValue={rule.reason}
                                    required
                                    textarea
                                    rows={4}
                                    style={{ gridColumn: 'span 2' }}
                                  />
                                  <div style={{ display: 'flex', alignItems: 'end' }}>
                                    <button className="btn btn--accent" style={{ width: 'auto' }} type="submit">
                                      Save rule
                                    </button>
                                  </div>
                                </form>
                              </details>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </section>
            );
          })
        )}

        <div className="dash-grid" style={{ marginBottom: 24 }}>
          <AddRuleCard projects={projects} scopedProjectId={scopedProject?.id ?? null} />
          <ExceptionCard policies={policies} projects={projects} />
        </div>

        <section className="card" style={{ padding: 28 }}>
          <div className="card__head">
            <h2 className="card__title">
              Policy <em>exceptions</em>
            </h2>
            <span className="card__role">{exceptions.length} records</span>
          </div>
          {exceptions.length === 0 ? (
            <div style={{ color: 'var(--ink-dim)' }}>No exceptions requested.</div>
          ) : (
            exceptions.map((exception) => (
              <div key={exception.id} className="policy-row">
                <div className="policy-row__verdict" style={{ color: verdictColor(exception.decisionOverride) }}>
                  {exception.decisionOverride.toUpperCase()}
                </div>
                <div>
                  <div className="policy-row__pattern">
                    {exception.scopeType} · {exception.status}
                  </div>
                  <div style={monoDim}>{exception.scopeJson}</div>
                </div>
                <div className="policy-row__reason">{exception.reason}</div>
                <div style={monoDim}>
                  {exception.expiresAt !== null ? `expires ${exception.expiresAt.toLocaleString()}` : 'no expiry'}
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  {exception.status === 'requested' ? (
                    <>
                      <ExceptionStatusButton id={exception.id} status="active" label="approve" />
                      <ExceptionStatusButton id={exception.id} status="rejected" label="reject" />
                    </>
                  ) : null}
                  {exception.status === 'active' ? (
                    <ExceptionStatusButton id={exception.id} status="revoked" label="revoke" />
                  ) : null}
                </div>
              </div>
            ))
          )}
        </section>
      </section>
    </>
  );
}

function AddRuleCard({
  projects,
  scopedProjectId,
}: {
  projects: ReadonlyArray<{ id: string; slug: string }>;
  scopedProjectId: string | null;
}) {
  return (
    <div className="aside-card">
      <h3 className="aside-card__title" style={{ marginBottom: 14 }}>
        Add a <em>rule</em>
      </h3>
      <form action={addRuleAction}>
        <SelectProject projects={projects} scopedProjectId={scopedProjectId} />
        <SelectField
          label="Evaluator"
          name="evaluator"
          options={POLICY_EVALUATORS.map((evaluator) => `${evaluator.key}::${evaluator.label}`)}
          valueLabel={(value) => value.split('::')[1] ?? value}
          valueTransform={(value) => value.split('::')[0] ?? value}
          help="The evaluator decides which event, matcher fields, and decisions make sense."
        />
        <div style={{ display: 'grid', gap: 8, marginBottom: 14 }}>
          {POLICY_EVALUATORS.map((evaluator) => (
            <div key={evaluator.key} style={evaluatorHintStyle} title={evaluator.description}>
              <strong>{evaluator.label}</strong>
              <span>{evaluator.events.join(' / ')}</span>
              <span style={{ gridColumn: '1 / -1' }}>{evaluator.examples.join(' · ')}</span>
            </div>
          ))}
        </div>
        <SelectField label="Group" name="groupKey" options={Object.keys(GROUP_LABELS)} help="Governance domain." />
        <Field label="Policy name" name="policyName" placeholder="__default__" />
        <Field label="Control key" name="controlKey" placeholder="shell-human-attestation" />
        <SelectField
          label="Event"
          name="matchEventType"
          options={['PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop', 'ConfigChange', 'SessionStart', 'SessionEnd']}
          help="Lifecycle moment where this rule is evaluated."
        />
        <SelectField
          label="Decision"
          name="decision"
          options={['deny', 'ask', 'allow', 'block', 'flag', 'record', 'warn', 'pass']}
          help="Use deny/ask/allow for tool calls; block/flag/record for lifecycle evaluators."
        />
        <Field
          label="Tool name"
          name="matchToolName"
          placeholder="Bash · Write · Read · mcp__github__*"
          help="Leave empty for lifecycle evaluators. Bash Command fills Bash automatically."
        />
        <Field label="Path glob" name="matchPathGlob" placeholder="**/.env" help="Required for Protected Files." />
        <Field
          label="Command pattern"
          name="matchCommandPattern"
          placeholder="git push*--force*"
          help="Required for Bash Command. Supports glob-style matching."
        />
        <SelectField
          label="Severity"
          name="severity"
          options={['low', 'medium', 'high', 'critical']}
          help="Critical controls are shown as highest audit risk."
        />
        <Field label="Reason" name="reason" placeholder="Why this control exists." required textarea />
        <Field label="Priority" name="priority" placeholder="100" />
        <button className="btn btn--accent" style={{ width: '100%' }} type="submit">
          Add rule
        </button>
      </form>
    </div>
  );
}

function ExceptionCard({
  policies,
  projects,
}: {
  policies: ReadonlyArray<{
    id: string;
    name: string;
    projectId: string;
    rules: ReadonlyArray<{ id: string; matchToolName: string; matchPathGlob: string | null }>;
  }>;
  projects: ReadonlyArray<{ id: string; slug: string }>;
}) {
  const firstPolicy = policies[0];
  return (
    <div className="aside-card">
      <h3 className="aside-card__title" style={{ marginBottom: 14 }}>
        Request an <em>exception</em>
      </h3>
      {firstPolicy === undefined ? (
        <div style={{ color: 'var(--ink-dim)' }}>Create a policy before requesting exceptions.</div>
      ) : (
        <form action={requestPolicyExceptionAction}>
          <SelectProject projects={projects} scopedProjectId={firstPolicy.projectId} />
          <SelectField
            label="Policy"
            name="policyId"
            options={policies.map((policy) => `${policy.id}::${policy.name}`)}
            valueLabel={(value) => value.split('::')[1] ?? value}
            valueTransform={(value) => value.split('::')[0] ?? value}
          />
          <SelectField
            label="Rule"
            name="ruleId"
            options={[
              '',
              ...policies.flatMap((policy) =>
                policy.rules.map(
                  (rule) =>
                    `${rule.id}::${rule.matchToolName}${rule.matchPathGlob !== null ? ` ${rule.matchPathGlob}` : ''}`,
                ),
              ),
            ]}
            valueLabel={(value) => (value === '' ? 'whole policy' : (value.split('::')[1] ?? value))}
            valueTransform={(value) => value.split('::')[0] ?? value}
          />
          <SelectField
            label="Scope"
            name="scopeType"
            options={['project', 'work_pack', 'path', 'tool', 'agent', 'session']}
          />
          <Field label="Scope value" name="scopeValue" placeholder="COOD-27 · **/migrations/** · Bash" />
          <SelectField label="Override" name="decisionOverride" options={['ask', 'allow', 'deny']} />
          <Field
            label="Reason"
            name="reason"
            placeholder="Temporary migration work requires shell commands."
            required
          />
          <Field label="Justification" name="justification" placeholder="Who approved and why." required textarea />
          <Field label="Expires at" name="expiresAt" placeholder="2026-08-08T18:00:00" />
          <label style={{ ...monoDim, display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14 }}>
            <input type="checkbox" name="activateNow" />
            activate immediately
          </label>
          <button className="btn btn--accent" style={{ width: '100%' }} type="submit">
            Request exception
          </button>
        </form>
      )}
    </div>
  );
}

function SelectProject({
  projects,
  scopedProjectId,
}: {
  projects: ReadonlyArray<{ id: string; slug: string }>;
  scopedProjectId: string | null;
}) {
  if (projects.length <= 1) return <input type="hidden" name="projectId" value={projects[0]?.id ?? '__global__'} />;
  return (
    <div className="field" style={{ marginBottom: 14 }}>
      <label htmlFor="policy-project" className="field__label" style={fieldLabelStyle}>
        Project
      </label>
      <select
        id="policy-project"
        name="projectId"
        defaultValue={scopedProjectId ?? projects[0]?.id ?? ''}
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
  );
}

function ExceptionStatusButton({
  id,
  status,
  label,
}: {
  id: string;
  status: 'active' | 'revoked' | 'rejected';
  label: string;
}) {
  return (
    <form action={updatePolicyExceptionStatusAction}>
      <input type="hidden" name="exceptionId" value={id} />
      <input type="hidden" name="status" value={status} />
      <input type="hidden" name="returnTo" value="/policies" />
      <button className="badge" type="submit">
        {label}
      </button>
    </form>
  );
}

function RemoveRuleControl({ ruleId }: { ruleId: string }) {
  return (
    <details style={{ textAlign: 'right' }}>
      <summary className="badge" style={removeSummaryStyle} title="Confirm before deleting this rule">
        remove
      </summary>
      <form action={deleteRuleAction} style={removeConfirmStyle}>
        <input type="hidden" name="ruleId" value={ruleId} />
        <input type="hidden" name="returnTo" value="/policies" />
        <div style={{ ...monoDim, marginBottom: 8 }}>Remove this rule?</div>
        <button className="badge" type="submit" title="Confirm rule deletion">
          confirm remove
        </button>
      </form>
    </details>
  );
}

function Stat({ title, value, detail }: { title: string; value: string; detail: string }) {
  return (
    <div className="aside-card" style={{ margin: 0 }}>
      <div style={monoDim}>{title}</div>
      <div style={{ fontFamily: 'var(--serif)', fontSize: 24, marginTop: 6 }}>{value}</div>
      <div style={{ color: 'var(--ink-dim)', marginTop: 4 }}>{detail}</div>
    </div>
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
  defaultValue,
  required,
  textarea,
  help,
  rows,
  style,
}: {
  label: string;
  name: string;
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
  textarea?: boolean;
  help?: string;
  rows?: number;
  style?: React.CSSProperties;
}) {
  const fieldId = `policy-field-${name}`;
  return (
    <div className="field" style={{ marginBottom: 14, ...style }}>
      <label htmlFor={fieldId} className="field__label" style={fieldLabelStyle}>
        {label}
      </label>
      {textarea ? (
        <textarea
          id={fieldId}
          name={name}
          placeholder={placeholder}
          defaultValue={defaultValue}
          required={required}
          style={fieldInputStyle}
          rows={rows ?? 2}
        />
      ) : (
        <input
          id={fieldId}
          name={name}
          placeholder={placeholder}
          defaultValue={defaultValue}
          required={required}
          style={fieldInputStyle}
        />
      )}
      {help !== undefined ? <div style={fieldHelpStyle}>{help}</div> : null}
    </div>
  );
}

function SelectField({
  label,
  name,
  options,
  valueLabel,
  valueTransform,
  defaultValue,
  help,
}: {
  label: string;
  name: string;
  options: ReadonlyArray<string>;
  valueLabel?: (value: string) => string;
  valueTransform?: (value: string) => string;
  defaultValue?: string;
  help?: string;
}) {
  const selectId = `policy-select-${name}`;
  return (
    <div className="field" style={{ marginBottom: 14 }}>
      <label htmlFor={selectId} className="field__label" style={fieldLabelStyle}>
        {label}
      </label>
      <select id={selectId} name={name} defaultValue={defaultValue} style={fieldInputStyle}>
        {options.map((option) => (
          <option key={option} value={valueTransform?.(option) ?? option}>
            {valueLabel?.(option) ?? option}
          </option>
        ))}
      </select>
      {help !== undefined ? <div style={fieldHelpStyle}>{help}</div> : null}
    </div>
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
};

const fieldHelpStyle: React.CSSProperties = {
  marginTop: 5,
  color: 'var(--ink-dim)',
  fontSize: 11,
  lineHeight: 1.35,
};

const evaluatorHintStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr auto',
  gap: '2px 10px',
  padding: '8px 10px',
  border: '1px solid var(--rule)',
  color: 'var(--ink-dim)',
  fontSize: 11,
  lineHeight: 1.3,
};

const editSummaryStyle: React.CSSProperties = {
  cursor: 'pointer',
  fontFamily: 'var(--mono)',
  fontSize: 10,
  color: 'var(--accent)',
  margin: '0 0 12px 0',
  paddingLeft: 8,
};

const editRuleGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
  gap: 12,
  padding: '14px',
  border: '1px solid var(--rule)',
};

const removeSummaryStyle: React.CSSProperties = {
  display: 'inline-block',
  cursor: 'pointer',
  listStyle: 'none',
};

const removeConfirmStyle: React.CSSProperties = {
  marginTop: 8,
  padding: 10,
  border: '1px solid var(--warn)',
  background: 'var(--warn-glow)',
  minWidth: 150,
};

const monoDim: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 10,
  color: 'var(--ink-dim)',
  letterSpacing: '0.04em',
};

function verdictColor(decision: string): string {
  if (decision === 'deny') return 'var(--warn)';
  if (decision === 'ask') return 'var(--caution)';
  return 'var(--accent)';
}

function groupPolicies<T extends { groupKey: string }>(
  policies: ReadonlyArray<T>,
): ReadonlyArray<readonly [string, T[]]> {
  const map = new Map<string, T[]>();
  for (const policy of policies) {
    const key = policy.groupKey in GROUP_LABELS ? policy.groupKey : 'custom';
    const rows = map.get(key) ?? [];
    rows.push(policy);
    map.set(key, rows);
  }
  return Object.keys(GROUP_LABELS)
    .filter((key) => (map.get(key)?.length ?? 0) > 0)
    .map((key) => [key, map.get(key) ?? []] as const);
}
