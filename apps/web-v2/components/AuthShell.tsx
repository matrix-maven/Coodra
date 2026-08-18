import Link from 'next/link';
import type { ReactNode } from 'react';

import styles from './AuthShell.module.css';

/**
 * `AuthShell` — the editorial two-panel surface that wraps Clerk's
 * `<SignIn>` / `<SignUp>` widgets on `/auth/sign-in` and `/auth/sign-up`.
 *
 * UI only: the actual authentication (password, Google, GitHub, MFA,
 * verification) is still handled entirely by the Clerk component passed
 * as `children`. This component renders the brand panel + the editorial
 * chrome (eyebrow, title, sub, tabs, terms); the Clerk widget itself is
 * themed card-less via `clerkAuthAppearance` so it sits flush inside the
 * right panel.
 *
 * The shell is a full-bleed `position: fixed` overlay (see the CSS
 * module) because the root layout always renders the app sidebar — an
 * unauthenticated visitor should see only this screen, so it covers the
 * chrome rather than squeezing into the main content column.
 */

const COPY = {
  signin: {
    num: '01',
    title: (
      <>
        Sign in to <em>Coodra</em>.
      </>
    ),
    sub: 'Pick up where your agents left off — runs, decisions, packs, and the audit trail behind every change.',
    topText: 'New here?',
    topLinkLabel: 'Create account',
    topLinkHref: '/auth/sign-up',
  },
  signup: {
    num: '02',
    title: (
      <>
        Create your <em>workspace</em>.
      </>
    ),
    sub: 'Spin up a project, point your agent at it, and start recording every tool call, decision, and policy verdict.',
    topText: 'Have an account?',
    topLinkLabel: 'Sign in',
    topLinkHref: '/auth/sign-in',
  },
} as const;

const GITHUB_URL = 'https://github.com/matrix-maven/Coodra';
const DOCS_URL = 'https://github.com/matrix-maven/Coodra#readme';

export function AuthShell({ mode, children }: { mode: 'signin' | 'signup'; children: ReactNode }) {
  const c = COPY[mode];

  return (
    <main className={styles.auth}>
      {/* ---------- LEFT: brand ---------- */}
      <aside className={styles.brand}>
        <div className={`${styles.axis} ${styles.axisTop}`} />
        <div className={`${styles.axis} ${styles.axisMid}`}>
          <span className={styles.axisNode} style={{ left: '18%' }} />
          <span
            className={styles.axisNode}
            style={{ left: '46%', background: 'var(--ink)', boxShadow: '0 0 0 4px rgba(232,230,225,0.06)' }}
          />
          <span className={styles.axisNode} style={{ left: '78%' }} />
        </div>

        <div className={styles.brandTop}>
          <Link className={styles.logo} href="/">
            <span className={styles.logoMark}>
              <svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
                <circle cx="24" cy="24" r="22" stroke="#7dd87d" strokeWidth="1.2" />
                <circle cx="24" cy="24" r="3" fill="#7dd87d" />
                <line x1="2" y1="24" x2="46" y2="24" stroke="#e8e6e1" strokeWidth="0.7" strokeDasharray="2 3" />
              </svg>
            </span>
            <span className={styles.logoWord}>Coodra</span>
          </Link>
          <span className={styles.brandMeta}>local-first · MCP-native</span>
        </div>

        <div className={styles.brandBody}>
          <div className={styles.brandEyebrow}>/ access · the coordination layer</div>
          <h1 className={styles.brandTitle}>
            Master the
            <br />
            <em>context.</em>
          </h1>
          <p className={styles.brandLede}>
            Your agents receive project context before coding, follow policies during coding, and produce traceable
            records after. Sign in to your workspace to see what they did, why, and what changed.
          </p>

          <div className={styles.brandEvents}>
            <div className={styles.ev}>
              <span className={styles.evDot} />
              <span className={styles.evTime}>14:02:11</span>
              <span className={styles.evTool}>
                read · <b>src/server/hooks.ts</b>
              </span>
              <span className={styles.evVerdict}>ALLOW</span>
            </div>
            <div className={styles.ev}>
              <span className={`${styles.evDot} ${styles.evDotW}`} />
              <span className={styles.evTime}>14:02:14</span>
              <span className={styles.evTool}>grep · &quot;verdict&quot; services/</span>
              <span className={styles.evVerdict}>ALLOW</span>
            </div>
            <div className={styles.ev}>
              <span className={`${styles.evDot} ${styles.evDotWarn}`} />
              <span className={styles.evTime}>14:02:18</span>
              <span className={styles.evTool}>
                edit · <b>prod/.env</b>
              </span>
              <span className={`${styles.evVerdict} ${styles.evVerdictWarn}`}>DENY</span>
            </div>
          </div>
        </div>

        <div className={styles.brandFoot}>
          <div>
            <strong>Coodra</strong>
            <br />
            Open source · Apache-2.0
          </div>
          <div style={{ textAlign: 'right' }}>
            <a href={DOCS_URL} target="_blank" rel="noreferrer">
              docs ↗
            </a>
            <br />
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">
              github ↗
            </a>
          </div>
        </div>
      </aside>

      {/* ---------- RIGHT: form ---------- */}
      <section className={styles.panel}>
        <div className={styles.panelTop}>
          <span className={styles.panelTopText}>{c.topText}</span>
          <Link href={c.topLinkHref} className={styles.panelTopLink}>
            {c.topLinkLabel}
          </Link>
        </div>

        <div className={styles.panelBody}>
          <div className={styles.panelNum}>
            /access<strong>{c.num}</strong>
          </div>
          <h2 className={styles.panelTitle}>{c.title}</h2>
          <p className={styles.panelSub}>{c.sub}</p>

          <nav className={styles.tabs} aria-label="Authentication">
            <Link
              href="/auth/sign-in"
              className={`${styles.tab} ${mode === 'signin' ? styles.tabActive : ''}`}
              aria-current={mode === 'signin' ? 'page' : undefined}
            >
              Sign in
            </Link>
            <Link
              href="/auth/sign-up"
              className={`${styles.tab} ${mode === 'signup' ? styles.tabActive : ''}`}
              aria-current={mode === 'signup' ? 'page' : undefined}
            >
              Create account
            </Link>
          </nav>

          <div className={styles.clerkSlot}>{children}</div>

          <p className={styles.terms}>
            By continuing you agree to the{' '}
            <a href={DOCS_URL} target="_blank" rel="noreferrer">
              terms
            </a>{' '}
            and{' '}
            <a href={DOCS_URL} target="_blank" rel="noreferrer">
              privacy policy
            </a>
            . Coodra is local-first; your runs stay on your machine until you opt-in to sync.
          </p>
        </div>

        <div className={styles.panelFoot}>
          <span>© 2026 Coodra</span>
          <span>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">
              status
            </a>{' '}
            ·{' '}
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">
              support
            </a>
          </span>
        </div>
      </section>
    </main>
  );
}
