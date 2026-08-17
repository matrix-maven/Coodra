import Link from 'next/link';

import { Topbar } from '@/components/Topbar';
import { resolveDeploymentMode } from '@/lib/deployment-mode';
import {
  type ActorUtilization,
  type FreshnessBreakdown,
  fetchMemoryUtilization,
  type MemoryUtilizationSnapshot,
  type SurfacedDecision,
  type SurfaceUtilization,
} from '@/lib/queries/memory-utilization';

export const dynamic = 'force-dynamic';

/**
 * `/memory` — utilization, not inventory (COOD-87).
 *
 * The existing surfaces count what Coodra has STORED. That number goes
 * up when Coodra nags effectively and would look healthy on a project
 * where every pack is noise nobody reads. This page asks the two
 * questions that actually matter:
 *
 *   - **pull-through rate** — was this memory wanted?
 *   - **stale share** — was it still trustworthy?
 *
 * Deliberately no composite "memory health" score. A single figure
 * hides the diagnostics that make it actionable, and the failure modes
 * it would average together have opposite fixes.
 *
 * Every number reads from the COOD-79 rollups, never raw
 * `memory_access_events` — those are pruned on a retention window, so
 * a page reading them would silently lose history and degrade on
 * exactly the long-running projects this exists to serve.
 */
export default async function MemoryPage() {
  const snap = await fetchMemoryUtilization();
  const dm = resolveDeploymentMode();

  return (
    <>
      <Topbar crumb="Memory" crumbPrefix={dm === 'team-hosted' ? 'coodra · team' : 'coodra · solo'} />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/05 · MEMORY · UTILIZATION</div>
            <h1 className="head__title">
              Memory <em>utilization</em>.
            </h1>
            <p className="head__lede">
              Not how much Coodra stored — how much of it was wanted, which surfaces earned a pull, and which decisions
              actually reached an agent.
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>{snap.bySurface.length} surfaces</strong>
              <br />
              {snap.surfacedDecisions.length} surfaced decisions
              <br />
              {dm === 'team-hosted' ? 'team hosted' : 'local rollups'}
            </div>
          </div>
        </div>

        {snap.noDataYet ? <PendingState teamHosted={dm === 'team-hosted'} /> : null}

        <DeadMemorySection snap={snap} />
        <FreshnessSection snap={snap} />
        <SurfacedDecisionsTable rows={snap.surfacedDecisions} />
        <SurfaceTable rows={snap.bySurface} />
        <ActorTable rows={snap.byActor} />

        <footer>
          <p>
            Read from the daily and cohort rollups, never from raw access events. Policy metrics live on{' '}
            <a href="/policies">Policies</a> — they come from <code>policy_decisions</code>, which records them with
            more fidelity than this log could.
          </p>
          <p className="muted">Fetched {snap.fetchedAt}</p>
        </footer>
      </section>
    </>
  );
}

/**
 * A fresh install has no rollups yet. Saying so explicitly matters:
 * every ratio below would otherwise render as "—" and read as broken
 * rather than pending.
 */
function PendingState({ teamHosted }: { teamHosted: boolean }) {
  return (
    <div className="empty">
      <strong>
        No rollups <em>yet</em>.
      </strong>
      <p>
        {teamHosted
          ? 'Team-hosted memory charts read synced daily and cohort rollups from each developer machine. The first numbers appear after local daemons roll up completed days and sync them.'
          : 'The rollup worker runs hourly in the coodra start daemon and only covers completed days, so the first numbers appear after a day of use.'}
      </p>
    </div>
  );
}

function pct(value: number | null): string {
  // "—" for null, never 0%. "We have shown nothing" and "we showed
  // things and nobody wanted them" are opposite diagnoses.
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

function DeadMemorySection({ snap }: { snap: MemoryUtilizationSnapshot }) {
  const { deadMemory: dm } = snap;
  return (
    <section>
      <div className="card__head">
        <h2 className="card__title">
          Created <em>to surfaced</em>
        </h2>
        <span className="card__role">Inventory gap</span>
      </div>
      <div className="stats">
        <Card
          label="Context packs never surfaced"
          value={`${dm.contextPacksNeverSurfaced}`}
          sub={`of ${dm.contextPacksTotal} created`}
          warn={dm.contextPacksTotal > 0 && dm.contextPacksNeverSurfaced / dm.contextPacksTotal > 0.5}
        />
        <Card
          label="Decisions never surfaced"
          value={`${dm.decisionsNeverSurfaced}`}
          sub={`of ${dm.decisionsTotal} recorded`}
          warn={dm.decisionsTotal > 0 && dm.decisionsNeverSurfaced / dm.decisionsTotal > 0.5}
        />
      </div>
    </section>
  );
}

function FreshnessSection({ snap }: { snap: MemoryUtilizationSnapshot }) {
  return (
    <section>
      <div className="card__head">
        <h2 className="card__title">
          Still <em>true</em>?
        </h2>
        <span className="card__role">Freshness</span>
      </div>
      <div className="stats">
        <FreshnessCard label="Context packs" breakdown={snap.packFreshness} />
        <FreshnessCard label="Decisions" breakdown={snap.decisionFreshness} />
      </div>
    </section>
  );
}

function FreshnessCard({ label, breakdown }: { label: string; breakdown: FreshnessBreakdown }) {
  const total = breakdown.fresh + breakdown.stale + breakdown.unverified;
  return (
    <div className="stat">
      <div className="stat__label">{label} — stale</div>
      <div className="stat__num">{breakdown.stale > 0 ? <em>{breakdown.stale}</em> : breakdown.stale}</div>
      <div className="stat__delta">
        {breakdown.fresh} verified fresh · {breakdown.unverified} unverified · {total} total
      </div>
    </div>
  );
}

function SurfacedDecisionsTable({ rows }: { rows: ReadonlyArray<SurfacedDecision> }) {
  if (rows.length === 0) {
    return (
      <section>
        <div className="card__head">
          <h2 className="card__title">
            Surfaced <em>decisions</em>
          </h2>
          <span className="card__role">Cohort rollup</span>
        </div>
        <div className="empty">
          <strong>
            No surfaced <em>decisions</em>.
          </strong>
          <p>
            Decision-level cohort rows will appear after a manifest or prompt context puts decisions in front of an
            agent.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="card__head">
        <h2 className="card__title">
          Surfaced <em>decisions</em>
        </h2>
        <span className="card__role">Which ones reached the agent</span>
      </div>
      <div className="card" style={{ padding: 0, marginBottom: 56 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Decision</th>
              <th>Surface</th>
              <th>Status</th>
              <th className="num">Surfaced</th>
              <th className="num">Pulled</th>
              <th className="num">Pull-through</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.id}:${row.surfacedSite}`}>
                <td style={{ maxWidth: 620 }}>
                  <div className="tbl__title">
                    <Link href={`/decisions/${encodeURIComponent(row.id)}`}>{row.description}</Link>
                  </div>
                  <div className="tbl__mono">{row.id}</div>
                </td>
                <td>
                  <code>{row.surfacedSite}</code>
                </td>
                <td>
                  <span className={row.staleAtAccess ? 'badge badge--warn' : 'badge'}>
                    <span className="badge__dot" />
                    {row.staleAtAccess ? 'stale when shown' : row.freshnessStatus}
                  </span>
                </td>
                <td className="num">{row.surfaced}</td>
                <td className="num">{row.pulled}</td>
                <td className="num">{pct(row.pullThroughRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SurfaceTable({ rows }: { rows: ReadonlyArray<SurfaceUtilization> }) {
  if (rows.length === 0) {
    return (
      <section>
        <div className="card__head">
          <h2 className="card__title">
            By <em>surface</em>
          </h2>
          <span className="card__role">Access doors</span>
        </div>
        <p className="head__lede">Nothing surfaced yet — no injections or retrievals have been rolled up.</p>
      </section>
    );
  }
  return (
    <section>
      <div className="card__head">
        <h2 className="card__title">
          By <em>surface</em>
        </h2>
        <span className="card__role">Access doors</span>
      </div>
      <div className="card" style={{ padding: 0, marginBottom: 56 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Surface</th>
              <th className="num">Accesses</th>
              <th className="num">Surfaced</th>
              <th className="num">Pulled</th>
              <th className="num">Pull-through</th>
              <th className="num">Stale share</th>
              <th className="num">Bytes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.surface}>
                <td>
                  <code>{row.surface}</code>
                </td>
                <td className="num">{row.totalAccesses}</td>
                <td className="num">{row.surfaced}</td>
                <td className="num">{row.pulled}</td>
                <td className="num">{pct(row.pullThroughRate)}</td>
                <td className="num">{pct(row.staleShare)}</td>
                <td className="num">{row.totalBytes.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * COOD-100 — who the utilization belongs to.
 *
 * Hidden when there is only one seat. In solo mode every row carries the
 * `local` sentinel, and a one-row "breakdown" is chrome that says
 * nothing. The section appears exactly when it starts to mean something:
 * more than one actor has used this project's memory.
 */
function ActorTable({ rows }: { rows: ReadonlyArray<ActorUtilization> }) {
  if (rows.length < 2) return null;
  const total = rows.reduce((sum, row) => sum + row.accesses, 0);
  return (
    <section>
      <div className="card__head">
        <h2 className="card__title">
          By <em>person</em>
        </h2>
        <span className="card__role">Seat utilization</span>
      </div>
      <div className="card" style={{ padding: 0, marginBottom: 56 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Actor</th>
              <th className="num">Accesses</th>
              <th className="num">Share</th>
              <th className="num">Bytes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.actorUserId}>
                <td>
                  <code>{row.actorUserId === 'local' ? 'local user' : row.actorUserId}</code>
                </td>
                <td className="num">{row.accesses}</td>
                <td className="num">{pct(ratioOf(row.accesses, total))}</td>
                <td className="num">{row.totalBytes.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ratioOf(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function Card({ label, value, sub, warn }: { label: string; value: string; sub: string; warn?: boolean }) {
  return (
    <div className="stat">
      <div className="stat__label">{label}</div>
      <div className="stat__num">{warn === true ? <em>{value}</em> : value}</div>
      <div className={warn === true ? 'stat__delta stat__delta--down' : 'stat__delta'}>{sub}</div>
    </div>
  );
}
