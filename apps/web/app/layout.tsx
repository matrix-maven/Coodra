import { ClerkProvider, OrganizationSwitcher, UserButton } from '@clerk/nextjs';
import type { Metadata } from 'next';
import { Cormorant_Garamond, Inter_Tight, JetBrains_Mono } from 'next/font/google';

import { Sidebar } from '@/components/Sidebar';
import { getActor } from '@/lib/auth';
import { clerkAppearance } from '@/lib/clerk-appearance';
import './globals.css';

/*
 * Three voices · brand kit
 *  - Cormorant Garamond — display, italic for emphasis
 *  - Inter Tight — body, UI, navigation
 *  - JetBrains Mono — paths · IDs · timestamps · eyebrows · code
 */

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

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
  weight: ['300', '400', '500', '600'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'ContextOS',
  description: 'Editorial audit surface for ContextOS — local-first, MCP-native, MIT.',
};

/**
 * Root layout · editorial dark shell.
 *
 * 248px persistent left sidebar (workspace + project nav, mode badge,
 * project pill, user avatar). The Sidebar component handles workspace
 * nav AND project nav (when inside /projects/[slug]/*). Project layout
 * adds the topbar + main landmark.
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
      <html
        lang="en"
        className={`${interTight.variable} ${cormorant.variable} ${jetbrainsMono.variable}`}
        suppressHydrationWarning
      >
        <body suppressHydrationWarning className="bg-bg-base text-text-primary">
          <a href="#main" className="skip-to-main">
            Skip to main content
          </a>

          <div className="grid min-h-screen grid-cols-[var(--sidebar-width)_1fr]">
            <Sidebar
              mode={actor.mode}
              footerSlot={
                actor.mode === 'team' ? (
                  <div className="flex items-center justify-between gap-2">
                    <OrganizationSwitcher
                      appearance={clerkAppearance}
                      hidePersonal
                      afterCreateOrganizationUrl="/"
                      afterSelectOrganizationUrl="/"
                    />
                    <UserButton appearance={clerkAppearance} userProfileUrl="/settings/account" />
                  </div>
                ) : undefined
              }
            />
            <div className="flex min-w-0 flex-col bg-bg-base">{children}</div>
          </div>
        </body>
      </html>
    </ClerkProvider>
  );
}
