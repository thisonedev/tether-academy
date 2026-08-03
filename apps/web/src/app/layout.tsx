import './global.css';
import { NotificationCenter, SiteHeader, UsernamePrompt } from '@academy/ui';
import { RootProvider } from 'fumadocs-ui/provider/next';
import type { ReactNode } from 'react';

export const metadata = {
  title: 'Tether Academy',
  description: "Learn to build on Tether's open-source stack. Start with QVAC.",
  other: {
    google: 'notranslate',
  },
};

/** Tag <html data-platform="desktop"> before paint when the desktop bridge is
 *  present, so CSS can pick the right header layout (controls + logo offset). */
const tagPlatformScript = `try{if(window.academy){document.documentElement.setAttribute('data-platform','desktop')}}catch(e){}`;

const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "img-src 'self' data: blob:",
  "font-src 'self' data: https://cdn.jsdelivr.net",
  "worker-src 'self' blob:",
  "connect-src 'self' https://cdn.jsdelivr.net",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** Root layout: site header, page content, and the self-determining sign-in modal. */
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <meta httpEquiv="Content-Security-Policy" content={contentSecurityPolicy} />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static string, no user input */}
        <script dangerouslySetInnerHTML={{ __html: tagPlatformScript }} />
      </head>
      <body
        className="flex min-h-screen flex-col bg-canvas text-canvas-foreground antialiased"
        suppressHydrationWarning
      >
        <RootProvider>
          <SiteHeader />
          <NotificationCenter />
          <div className="flex w-full flex-1 flex-col">{children}</div>
          <UsernamePrompt />
        </RootProvider>
      </body>
    </html>
  );
}
