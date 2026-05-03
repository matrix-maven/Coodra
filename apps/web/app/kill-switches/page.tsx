import { StatusChip } from '@/components/StatusChip';
import { pauseAction, resumeAction } from '@/lib/actions/kill-switches';
import { getActor } from '@/lib/auth';
import { listActive, MODES, SCOPES } from '@/lib/queries/kill-switches';

/**
 * `/kill-switches` — server-rendered admin per
 * `docs/feature-packs/04-web-app/wireframes/02-screens/kill-switches.md`.
 *
 * Three anchored sections:
 *   - Active — list of unresumed switches with Resume buttons
 *   - Pause new — server-action form
 *   - Propagation note — explains the team-mode sync semantics
 *     (S8a: ~10s p95 to all developers via sync-daemon puller)
 *
 * The puller lives in sync-daemon, not in the web app — the web's
 * job is to write to the local SQLite (solo) or cloud Postgres
 * (team) and let the daemon fan out.
 */

interface SearchParams {
  readonly paused?: string;
  readonly resumed?: string;
  readonly duplicate?: string;
  readonly scope?: string;
  readonly target?: string;
  readonly error?: string;
}

export default async function KillSwitchesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const actor = await getActor();
  const active = await listActive();

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-4xl font-black uppercase tracking-wide">Kill switches</h1>
        <p className="text-sm text-(--color-text-secondary)">
          Pause and resume agent enforcement at four scopes: global, project, tool, agent type. Hard mode denies on
          match; soft mode allows + audits.
        </p>
        <p className="text-xs text-(--color-text-tertiary)">
          {actor.mode === 'team'
            ? 'Pauses propagate to all developers within ~10s (sync-daemon pulls every 5s, bridge cache TTL 5s).'
            : 'Solo mode — pause is local only. No cross-developer propagation.'}
        </p>
      </header>

      <Banners {...sp} />

      <Section title={`Active (${active.length})`}>
        {active.length === 0 ? (
          <Empty hint="No active kill switches. Bridge enforcement is unrestricted." />
        ) : (
          <table className="w-full border border-(--color-border-subtle)">
            <thead className="bg-(--color-bg-elevated)">
              <tr>
                <Th>Mode</Th>
                <Th>Scope</Th>
                <Th>Reason</Th>
                <Th>Age</Th>
                <Th>Paused by</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {active.map((row) => (
                <tr key={row.id} className="border-b border-(--color-border-subtle)">
                  <td className="px-3 py-2">
                    <StatusChip status={row.mode === 'hard' ? 'error' : 'warning'}>{row.mode}</StatusChip>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {row.scope}
                    {row.target !== null ? `=${row.target}` : ''}
                  </td>
                  <td className="px-3 py-2 text-sm text-(--color-text-primary)" title={row.reason}>
                    {row.reason.length > 60 ? `${row.reason.slice(0, 60)}…` : row.reason}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-(--color-text-secondary)">
                    {ageString(row.pausedAt)}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-(--color-text-tertiary)">
                    {row.pausedBySessionId ?? '—'}
                  </td>
                  <td className="px-3 py-2">
                    <form action={resumeAction} className="inline">
                      <input type="hidden" name="id" value={row.id} />
                      <button
                        type="submit"
                        className="border border-(--color-border-default) bg-(--color-bg-base) px-3 py-1 font-display text-xs font-bold uppercase tracking-wider text-(--color-text-primary) hover:border-(--color-brand) hover:text-(--color-brand)"
                      >
                        Resume
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Pause new">
        <PauseForm
          {...(sp.duplicate !== undefined ? { dupId: sp.duplicate } : {})}
          {...(sp.scope !== undefined ? { dupScope: sp.scope } : {})}
          {...(sp.target !== undefined ? { dupTarget: sp.target } : {})}
        />
      </Section>
    </div>
  );
}

function Banners(sp: SearchParams) {
  return (
    <>
      {sp.paused !== undefined ? (
        <div className="border-l-4 border-(--color-status-success) bg-(--color-status-success)/10 px-4 py-3 text-sm">
          ✓ Paused (id <span className="font-mono">{sp.paused}</span>).
        </div>
      ) : null}
      {sp.resumed !== undefined ? (
        <div className="border-l-4 border-(--color-status-info) bg-(--color-status-info)/10 px-4 py-3 text-sm">
          ✓ Resumed (id <span className="font-mono">{sp.resumed}</span>).
        </div>
      ) : null}
      {sp.duplicate !== undefined ? (
        <div className="border-l-4 border-(--color-status-warning) bg-(--color-status-warning)/10 px-4 py-3 text-sm">
          ⚠ This scope is already paused — id <span className="font-mono">{sp.duplicate}</span>. Submit again with the
          force flag below to add a second active switch (the matcher's first-match-wins keeps the existing one in
          effect until resumed).
        </div>
      ) : null}
      {sp.error !== undefined ? (
        <div className="border-l-4 border-(--color-status-error) bg-(--color-status-error)/10 px-4 py-3 text-sm">
          ✕ {sp.error}
        </div>
      ) : null}
    </>
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
    <form
      action={pauseAction}
      className="grid gap-4 border border-(--color-border-subtle) bg-(--color-bg-surface) p-6 md:grid-cols-2"
    >
      <FormField label="Scope *" name="scope" type="select" options={[...SCOPES]} defaultValue={dupScope ?? 'global'} />
      <FormField
        label="Target (required for non-global)"
        name="target"
        placeholder="Bash | my-project | claude_code"
        defaultValue={dupTarget ?? ''}
      />
      <FormField label="Mode *" name="mode" type="select" options={[...MODES]} defaultValue="hard" />
      <FormField label="Expires at (optional)" name="expiresAt" placeholder="ISO 8601 (e.g. 2026-05-04T22:00:00Z)" />
      <FormField
        label="Reason *"
        name="reason"
        type="textarea"
        placeholder="why this kill switch — operator audit context"
        required
        full
      />
      {dupId !== undefined ? <input type="hidden" name="force" value="true" /> : null}
      <div className="md:col-span-2">
        <button
          type="submit"
          className="bg-(--color-status-error) px-6 py-2 font-display text-xs font-bold uppercase tracking-wider text-white hover:opacity-80"
        >
          {dupId !== undefined ? 'Pause anyway' : 'Pause'}
        </button>
      </div>
    </form>
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

function Empty({ hint }: { readonly hint: string }) {
  return (
    <div className="border border-(--color-border-subtle) bg-(--color-bg-surface) p-6 text-center text-sm text-(--color-text-tertiary)">
      {hint}
    </div>
  );
}

function Th({ children }: { readonly children: React.ReactNode }) {
  return (
    <th className="px-3 py-2 text-left font-display text-xs font-bold uppercase tracking-wider text-(--color-text-secondary)">
      {children}
    </th>
  );
}

interface FormFieldProps {
  readonly label: string;
  readonly name: string;
  readonly type?: 'text' | 'select' | 'textarea';
  readonly options?: readonly string[];
  readonly placeholder?: string;
  readonly defaultValue?: string;
  readonly required?: boolean;
  readonly full?: boolean;
}

function FormField({ label, name, type = 'text', options, placeholder, defaultValue, required, full }: FormFieldProps) {
  const inputId = `kill-${name}`;
  const inputClass =
    'border border-(--color-border-default) bg-(--color-bg-base) px-3 py-2 font-sans text-sm text-(--color-text-primary)';
  return (
    <div className={`flex flex-col gap-1 ${full === true ? 'md:col-span-2' : ''}`}>
      <label
        htmlFor={inputId}
        className="font-display text-xs font-bold uppercase tracking-wider text-(--color-text-secondary)"
      >
        {label}
      </label>
      {type === 'select' && options !== undefined ? (
        <select id={inputId} name={name} defaultValue={defaultValue} required={required} className={inputClass}>
          {options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      ) : type === 'textarea' ? (
        <textarea
          id={inputId}
          name={name}
          defaultValue={defaultValue}
          placeholder={placeholder}
          required={required}
          rows={3}
          className={inputClass}
        />
      ) : (
        <input
          id={inputId}
          type="text"
          name={name}
          defaultValue={defaultValue}
          placeholder={placeholder}
          required={required}
          className={inputClass}
        />
      )}
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
