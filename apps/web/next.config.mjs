import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

const isProd = process.env.NODE_ENV === 'production';
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? '';
const basePath = isProd && siteUrl.endsWith('github.io') ? '/tether-academy' : '';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
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
