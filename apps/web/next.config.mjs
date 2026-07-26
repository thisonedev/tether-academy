import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

const isProd = process.env.NODE_ENV === 'production';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  images: { unoptimized: true },
  trailingSlash: true,
  // Project page on thisonedev.github.io/tether-academy/ in production.
  // Stripped in dev so localhost:3000/ works as expected.
  basePath: isProd ? '/tether-academy' : '',
};

export default withMDX(nextConfig);
