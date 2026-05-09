import type { Metadata } from 'next';
import { Cormorant_Garamond, Inter_Tight, JetBrains_Mono } from 'next/font/google';

import { Sidebar } from '@/components/Sidebar';
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
  title: 'ContextOS — App',
  description: 'Editorial audit surface for ContextOS — local-first, MCP-native, MIT.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const mode = (process.env.CONTEXTOS_MODE === 'team' ? 'team' : 'solo') as 'solo' | 'team';
  const projects = (await safeListProjects()).map((p) => ({ slug: p.slug, name: p.name }));
  return (
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
          <Sidebar mode={mode} projects={projects} />
          <main className="main" id="main">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}

async function safeListProjects() {
  try {
    return await listProjects();
  } catch {
    return [] as Awaited<ReturnType<typeof listProjects>>;
  }
}
