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
  // Monaco's AMD loader is served from /monaco/vs, copied at build time.
  // No remote origin, so a CDN compromise, a TLS intercept, or a pinned-range
  // mistake cannot run code in the same origin that holds window.academy.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
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
