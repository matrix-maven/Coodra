import { Topbar } from '@/components/Topbar';
import { resolveDeploymentMode } from '@/lib/deployment-mode';
import {
  type FreshnessBreakdown,
  fetchMemoryUtilization,
  type MemoryUtilizationSnapshot,
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
        <header className="head">
          <h1>
            Memory <em>utilization</em>
          </h1>
          <p className="lede">
            Not how much Coodra stored — how much of it was <strong>wanted</strong>, and how much was still{' '}
            <strong>true</strong> when it was shown.
          </p>
        </header>

        {snap.noDataYet ? <PendingState /> : null}

        <DeadMemorySection snap={snap} />
        <FreshnessSection snap={snap} />
        <SurfaceTable rows={snap.bySurface} />

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
function PendingState() {
  return (
    <div className="empty">
      <strong>
        No rollups <em>yet</em>.
      </strong>
      <p>
        The rollup worker runs hourly in the <code>coodra start</code> daemon and only covers completed days, so the
        first numbers appear after a day of use. Counts below are still accurate.
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
      <h2>Created → surfaced</h2>
      <p className="lede">
        Memory that exists but has never been put in front of an agent. If this is most of what you have, retrieval
        tuning is premature — the problem is upstream.
      </p>
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
      <h2>Still true?</h2>
      <p className="lede">
        Gardening verifies memory against the working tree. <strong>Unverified is not fresh</strong> — it means nobody
        has checked, which is a different claim from &ldquo;this still holds&rdquo;.
      </p>
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

function SurfaceTable({ rows }: { rows: ReadonlyArray<SurfaceUtilization> }) {
  if (rows.length === 0) {
    return (
      <section>
        <h2>By surface</h2>
        <p className="lede">Nothing surfaced yet — no injections or retrievals have been rolled up.</p>
      </section>
    );
  }
  return (
    <section>
      <h2>By surface</h2>
      <p className="lede">
        Each door memory travels through. <strong>Pull-through</strong> is the share of surfaced items the agent then
        asked for by id — the closest thing to proof that context was used rather than merely sent.
      </p>
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
    </section>
  );
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
