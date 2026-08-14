// Mock SCORM 1.2 LMS: serves the generated package under a non-root path.
// Usage: node mock-lms-server.mjs [--staging <dir>] [--port <n>] [--entry <path>]

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MOUNT_PREFIX = '/scorm-mount';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

function shellHtml(entryHref) {
  return `<!doctype html>
<html>
<head><title>Mock LMS</title></head>
<body style="margin:0;font-family:sans-serif;">
  <div id="lms-bar" style="padding:6px 10px;background:#222;color:#0f0;font-size:12px;">
    mock LMS &mdash; cmi.core.lesson_status=<span id="status">unknown</span>,
    score=<span id="score">-</span>
  </div>
  <iframe id="sco" src="${entryHref}" style="width:100%;height:calc(100vh - 30px);border:0;"></iframe>
  <script>
    var cmi = JSON.parse(localStorage.getItem('mock-lms-cmi') || '{}');
    if (!cmi['cmi.core.student_name']) cmi['cmi.core.student_name'] = 'Doe, Jane';
    function persist() { localStorage.setItem('mock-lms-cmi', JSON.stringify(cmi)); }
    function refreshBar() {
      document.getElementById('status').textContent = cmi['cmi.core.lesson_status'] || 'unknown';
      document.getElementById('score').textContent = cmi['cmi.core.score.raw'] || '-';
    }
    window.API = {
      LMSInitialize: function () { return 'true'; },
      LMSFinish: function () { persist(); return 'true'; },
      LMSGetValue: function (name) { return cmi[name] || ''; },
      LMSSetValue: function (name, value) { cmi[name] = value; persist(); refreshBar(); return 'true'; },
      LMSCommit: function () { persist(); return 'true'; },
      LMSGetLastError: function () { return '0'; },
    };
    refreshBar();
  </script>
</body>
</html>`;
}

export async function startServer({ stagingDir, port = 0, entryPath }) {
  const entryHref = `${MOUNT_PREFIX}/${entryPath.replace(/^\/+/, '')}`;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(shellHtml(entryHref));
      return;
    }
    if (!url.pathname.startsWith(`${MOUNT_PREFIX}/`)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    let rel = decodeURIComponent(url.pathname.slice(MOUNT_PREFIX.length + 1));
    let filePath = path.join(stagingDir, rel);
    try {
      const st = await stat(filePath);
      if (st.isDirectory()) filePath = path.join(filePath, 'index.html');
      const body = await readFile(filePath);
      const ext = path.extname(filePath);
      res.writeHead(200, { 'content-type': CONTENT_TYPES[ext] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end(`not found: ${rel}`);
    }
  });

  await new Promise((resolve) => server.listen(port, resolve));
  const actualPort = server.address().port;
  return {
    url: `http://localhost:${actualPort}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const scormPkgDir = path.resolve(fileURLToPath(import.meta.url), '../..');
  const stagingDir = flag('staging', path.join(scormPkgDir, '.staging/qvac'));
  const entryPath = flag('entry', 'courses/qvac/en/getting-started/load-model/index.html');
  const port = Number(flag('port', '4173'));
  const { url } = await startServer({ stagingDir, port, entryPath });
  console.log(`[mock-lms] serving ${stagingDir}`);
  console.log(`[mock-lms] ${url}`);
}
