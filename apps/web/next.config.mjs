import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

const isProd = process.env.NODE_ENV === 'production';
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? '';
const basePath = isProd && siteUrl.endsWith('github.io') ? '/tether-academy' : '';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  // `next build` (export) and `next dev` (Turbopack) used to share `.next`.
  // A production build while the dev server was running deleted Turbopack's
  // manifests and every route started returning 500.
  distDir: isProd ? '.next' : '.next-dev',
  // Without this, @academy/ui is treated as an external node_modules package:
  // Turbopack resolves its compiled dist/ once at startup and never notices
  // it change, so a rebuilt package/ui needs a full dev server restart.
  transpilePackages: ['@academy/ui'],
  images: { unoptimized: true },
  trailingSlash: true,
  basePath,
  // Publish the basePath so client-side asset paths (e.g. Monaco's AMD loader) can be
  // prefixed the same way HTML anchors are.
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
};

export default withMDX(nextConfig);
