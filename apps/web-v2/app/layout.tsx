import type { Metadata } from 'next';
import { Cormorant_Garamond, Inter_Tight, JetBrains_Mono } from 'next/font/google';

import { Sidebar } from '@/components/Sidebar';
import { tryGetActor } from '@/lib/auth';
import { clerkAppearance } from '@/lib/clerk-appearance';
import { resolveDeploymentMode, resolveIdentityMode } from '@/lib/deployment-mode';
import { listProjects } from '@/lib/queries/projects';
import './globals.css';

const interTight = Inter_Tight({
  subsets: ['latin'],
  variable: '--font-inter-tight',
  weight: ['300', '400', '500', '600', '700'],
  display: 'swap',
});
const cormorant = Cormorant_Garamond({
  subsets: ['latin'],
  variable: '--font-cormorant',
  weight: ['400', '500', '600'],
  style: ['normal', 'italic'],
  display: 'swap',
});
const mono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
  weight: ['300', '400', '500', '600'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Coodra — App',
  description: 'Editorial audit surface for Coodra — local-first, MCP-native, MIT.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Phase G — binary identity mode dictates Clerk wiring. Legacy
  // three-mode `dm` is still passed to Sidebar for cosmetic UI flips
  // (laptop badge vs cloud badge), but identity itself is binary.
  const dm = resolveDeploymentMode();
  const idMode = resolveIdentityMode();
  const isTeam = idMode === 'team';
  const projects = (await safeListProjects()).map((p) => ({ slug: p.slug, name: p.name }));

  // Identity resolution: in team mode (laptop or cloud) read from Clerk
  // session (tryGetActor is non-throwing so unauthenticated /auth/sign-in
  // renders without crashing). In solo mode show the solo placeholder.
  let sidebarMode: 'solo' | 'team';
  let orgSlug: string | null = null;
  let viewerUserId: string | null = null;

  if (isTeam) {
    sidebarMode = 'team';
    const actor = await tryGetActor();
    if (actor !== null) {
      orgSlug = actor.orgId;
      viewerUserId = actor.userId;
    }
  } else {
    sidebarMode = 'solo';
  }

  // Sidebar footer slot — Clerk's <OrganizationSwitcher/> + <UserButton/>
  // render in team mode (laptop OR cloud) so the signed-in user can see
  // their identity, switch orgs, open /settings/account, and sign out.
  // Solo mode skips Clerk entirely — the bundle doesn't pay the cost.
  let footerSlot: React.ReactNode | undefined;
  if (isTeam) {
    const { OrganizationSwitcher, UserButton } = await import('@clerk/nextjs');
    footerSlot = (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          width: '100%',
          justifyContent: 'space-between',
        }}
      >
        <OrganizationSwitcher
          appearance={clerkAppearance}
          hidePersonal
          afterCreateOrganizationUrl="/"
          afterSelectOrganizationUrl="/"
          afterLeaveOrganizationUrl="/welcome"
        />
        <UserButton appearance={clerkAppearance} userProfileUrl="/settings/account" />
      </div>
    );
  }

  const shell = (
    <html
      lang="en"
      className={`${interTight.variable} ${cormorant.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <body suppressHydrationWarning>
        <a href="#main" className="skip-to-main">
          Skip to main content
        </a>
        <div className="app">
          <Sidebar
            mode={sidebarMode}
            deploymentMode={dm}
            projects={projects}
            orgSlug={orgSlug}
            viewerUserId={viewerUserId}
            footerSlot={footerSlot}
          />
          <main className="main" id="main">
            {children}
          </main>
        </div>
      </body>
    </html>
  );

  // Phase G — in any team mode (laptop or cloud), wrap the tree with
  // <ClerkProvider> so every Clerk hook + component (sign-in/sign-up
  // pages, <UserButton/>, <OrganizationSwitcher/>) gets the live session
  // context. Solo mode never loads Clerk — solo bundles don't pay the cost.
  if (isTeam) {
    const { ClerkProvider } = await import('@clerk/nextjs');
    return (
      <ClerkProvider
        appearance={clerkAppearance}
        signInUrl="/auth/sign-in"
        signUpUrl="/auth/sign-up"
        signInFallbackRedirectUrl="/"
        signUpFallbackRedirectUrl="/"
      >
        {shell}
      </ClerkProvider>
    );
  }
  return shell;
}

async function safeListProjects() {
  try {
    return await listProjects();
  } catch {
    return [] as Awaited<ReturnType<typeof listProjects>>;
  }
}
