import './global.css';
import { RootProvider } from 'fumadocs-ui/provider/next';
import type { ReactNode } from 'react';
import { SiteHeader } from '@/components/site-header';
import { UsernamePrompt } from '@/components/username-prompt';

export const metadata = {
  title: 'Tether Academy',
  description: "Learn to build on Tether's open-source stack. Start with QVAC.",
  other: {
    google: 'notranslate',
  },
};

/** Root layout: site header, page content, and the self-determining sign-in modal. */
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className="flex min-h-screen flex-col bg-canvas text-canvas-foreground antialiased"
        suppressHydrationWarning
      >
        <RootProvider>
          <SiteHeader />
          <div className="flex w-full flex-1 flex-col">{children}</div>
          <UsernamePrompt />
        </RootProvider>
      </body>
    </html>
  );
}
