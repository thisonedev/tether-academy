// Static file server for `next export` output. `next start` needs SSR.

import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

const ROOT = path.resolve('out');
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
const BASE_PATH = (process.env.BASE_PATH ?? '').replace(/\/$/, '');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.mdx': 'text/markdown; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

function mimeFor(p) {
  return MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream';
}

const server = createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (BASE_PATH && (urlPath === BASE_PATH || urlPath.startsWith(`${BASE_PATH}/`))) {
      urlPath = urlPath.slice(BASE_PATH.length) || '/';
    }
    if (urlPath.endsWith('/')) urlPath = urlPath.slice(0, -1);
    const abs = path.join(ROOT, urlPath);
    if (!abs.startsWith(ROOT)) {
      res.writeHead(403);
      res.end();
      return;
    }
    let resolved = abs;
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      stat = null;
    }
    if (stat?.isDirectory()) {
      resolved = path.join(abs, 'index.html');
    } else if (!stat && !path.extname(abs)) {
      resolved = path.join(`${abs}/`, 'index.html');
    } else if (!stat) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    const data = await fs.readFile(resolved);
    res.writeHead(200, { 'Content-Type': mimeFor(resolved), 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`> Serving ${ROOT} on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});
