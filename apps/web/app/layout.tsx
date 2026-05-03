import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';

import { Breadcrumb } from '@/components/Breadcrumb';
import { HeaderNav } from '@/components/HeaderNav';
import { getActor } from '@/lib/auth';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  weight: ['300', '400', '500', '700', '900'],
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
  weight: ['400', '500', '700'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'ContextOS',
  description: 'Admin + audit-trail UI for ContextOS — Module 04 Web App.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const actor = await getActor();
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body>
        <HeaderNav actor={actor} />
        <Breadcrumb />
        <main className="mx-auto max-w-[1200px] px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
