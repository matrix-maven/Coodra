import { ClerkProvider, OrganizationSwitcher, UserButton } from '@clerk/nextjs';
import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';

import { Sidebar } from '@/components/Sidebar';
import { SoloModeBadge } from '@/components/SoloModeBadge';
import { getActor } from '@/lib/auth';
import { clerkAppearance } from '@/lib/clerk-appearance';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  weight: ['300', '400', '500', '600', '700'],
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
  weight: ['400', '500', '600'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'ContextOS',
  description: 'Admin + audit-trail UI for ContextOS — Module 04 Web App.',
};

/**
 * Root layout — full UI redesign.
 *
 * The shell is a 248px persistent sidebar + flexible content area.
 * The Sidebar component handles workspace nav AND project nav (when
 * inside /projects/[slug]/*) so we no longer need a separate sub-nav
 * strip. The project /layout.tsx renders the project context band
 * + adds <main id="main"> for the skip-link target.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const actor = await getActor();
  return (
    <ClerkProvider
      appearance={clerkAppearance}
      signInUrl="/auth/sign-in"
      signUpUrl="/auth/sign-up"
      signInFallbackRedirectUrl="/"
      signUpFallbackRedirectUrl="/"
    >
      <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
        <body>
          <a href="#main" className="skip-to-main">
            Skip to main content
          </a>

          <div className="flex min-h-screen">
            <Sidebar
              mode={actor.mode}
              footerSlot={
                actor.mode === 'solo' ? (
                  <SoloModeBadge />
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <OrganizationSwitcher
                      appearance={clerkAppearance}
                      hidePersonal
                      afterCreateOrganizationUrl="/"
                      afterSelectOrganizationUrl="/"
                    />
                    <UserButton appearance={clerkAppearance} userProfileUrl="/settings/account" />
                  </div>
                )
              }
            />
            <div className="flex min-w-0 flex-1 flex-col bg-bg-base">{children}</div>
          </div>
        </body>
      </html>
    </ClerkProvider>
  );
}
