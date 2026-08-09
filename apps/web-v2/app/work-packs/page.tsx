import Link from 'next/link';

import { Topbar } from '@/components/Topbar';
import { listWorkPacksByProject } from '@/lib/queries/work-packs';
import {
  formatWorkPackProviderSummary,
  formatWorkPackSyncBadge,
  summarizeWorkPackGroup,
} from '@/lib/work-pack-display';

export const dynamic = 'force-dynamic';

export default async function WorkPacksPage() {
  const groups = await listWorkPacksByProject();
  const total = groups.reduce((n, group) => n + group.packs.length, 0);
  const allSummary = summarizeWorkPackGroup(groups.flatMap((group) => group.packs));

  return (
    <>
      <Topbar crumb="Work Packs" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/12 · KNOWLEDGE · WORK PACKS</div>
            <h1 className="head__title">
              Issue-bound work, <em>kept local and linked</em>.
            </h1>
            <p className="head__lede">
              Work Packs are Coodra&apos;s local implementation record for Jira epics, stories, tasks, bugs, and
              subtasks. Atlassian keeps auth and issue state; the agent syncs selected issue context into Coodra so
              later sessions can resume with requirements, relationships, and write-back notes in one place.
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>
                {total} work pack{total === 1 ? '' : 's'}
              </strong>
              <br />
              {formatWorkPackProviderSummary(allSummary)}
              <br />
              .coodra/work-packs/
            </div>
          </div>
        </div>

        {total === 0 ? (
          <div className="empty">
            <strong>
              No Work Packs <em>yet</em>.
            </strong>
            Run <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>coodra work import COOD-12</span>{' '}
            from a project root, then ask your agent to import the issue through Atlassian MCP.
          </div>
        ) : (
          <div className="pack-grid">
            {groups.map((group) => {
              const summary = summarizeWorkPackGroup(group.packs);
              const latest = group.packs.reduce<Date | null>(
                (max, pack) => (max === null || pack.updatedAt > max ? pack.updatedAt : max),
                null,
              );
              return (
                <Link
                  key={group.projectId}
                  className="pack"
                  href={`/work-packs/${encodeURIComponent(group.projectSlug)}`}
                  style={{ textDecoration: 'none' }}
                >
                  <div
                    className="pack__num"
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}
                  >
                    <span>/ {group.projectSlug.toUpperCase()}</span>
                    <span
                      className={`badge ${
                        summary.jiraLinked === 0 || summary.syncedJira === summary.jiraLinked
                          ? 'badge--ok'
                          : 'badge--caution'
                      }`}
                    >
                      <span className="badge__dot"></span>
                      {formatWorkPackSyncBadge(summary)}
                    </span>
                  </div>
                  <h3 className="pack__title">{group.projectName}</h3>
                  <p className="pack__excerpt">
                    {group.packs.length} work pack{group.packs.length === 1 ? '' : 's'} ·{' '}
                    {formatWorkPackProviderSummary(summary)}
                  </p>
                  <div className="pack__meta">
                    <span>{latest !== null ? formatRelative(latest) : 'no updates'}</span>
                    <span style={{ marginLeft: 'auto', color: 'var(--ink-mute)' }}>OPEN PROJECT →</span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}

function formatRelative(d: Date): string {
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
