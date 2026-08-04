// Collects device hardware info for the Settings page. Best-effort across
// platforms; anything not detectable returns null/empty rather than throwing.

const os = require('node:os');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PROBE_TIMEOUT_MS = 4000;

function runProbe(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      timeout: PROBE_TIMEOUT_MS,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch {
    return '';
  }
}

function classifyOs(platform) {
  switch (platform) {
    case 'darwin':
      return 'macos';
    case 'linux':
      return 'linux';
    case 'win32':
      return 'windows';
    default:
      return 'other';
  }
}

function osLabel(platform, release, version) {
  if (platform === 'darwin') {
    // darwin release is the kernel major, not the marketing version; sw_vers gives the real one.
    const sw = runProbe('sw_vers', ['-productVersion']);
    const name = runProbe('sw_vers', ['-productName']);
    const ver = sw.trim() || release;
    return name.trim() ? `${name.trim()} ${ver}` : `macOS ${ver}`;
  }
  if (platform === 'win32') {
    return `Windows ${release || ''}`.trim();
  }
  if (platform === 'linux') {
    const pretty = runProbe('sh', ['-c', 'cat /etc/os-release 2>/dev/null | grep ^PRETTY_NAME= | head -1']);
    const match = /PRETTY_NAME="?([^"]+)"?/.exec(pretty);
    if (match) return match[1];
    return `Linux ${release || ''}`.trim();
  }
  return `${platform} ${release || ''}`.trim();
}

function rootStoragePath(platform) {
  if (platform === 'win32') {
    // Use the drive the home dir lives on; usually C:.
    const home = os.homedir();
    const m = /^([A-Za-z]):[\\/]/.exec(home);
    if (m) return `${m[1].toUpperCase()}:\\`;
    return 'C:\\';
  }
  return '/';
}

async function statfsSafe(p) {
  try {
    const s = await fsp.statfs(p);
    return {
      total: Number(s.bsize) * Number(s.blocks),
      free: Number(s.bsize) * Number(s.bavail),
    };
  } catch {
    return null;
  }
}

function probeGpu(platform) {
  if (platform === 'darwin') {
    const out = runProbe('system_profiler', ['SPDisplaysDataType', '-detailLevel', 'mini']);
    return parseMacGpu(out);
  }
  if (platform === 'linux') {
    const out = runProbe('sh', ['-c', 'lspci 2>/dev/null | grep -Ei "vga|3d|display"']);
    return parseLinuxGpu(out);
  }
  if (platform === 'win32') {
    // wmic is deprecated but ships everywhere; PowerShell fallback below.
    let out = runProbe('wmic', [
      'path',
      'win32_VideoController',
      'get',
      'name,adapterram',
      '/format:list',
    ]);
    if (!out.trim()) {
      out = runProbe('powershell', [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name",
      ]);
    }
    return parseWindowsGpu(out);
  }
  return null;
}

function parseMacGpu(out) {
  if (!out) return null;
  // macOS names the GPU the same as the SoC on Apple Silicon.
  const m = /Chipset Model:\s*([^\n]+)/.exec(out);
  if (!m) return null;
  const name = m[1].trim();
  const cores = /Total Number of Cores:\s*(\d+)/.exec(out);
  if (cores) return `${name} (${cores[1]} GPU cores)`;
  return name;
}

function parseLinuxGpu(out) {
  if (!out) return null;
  const lines = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    const colon = line.indexOf(':');
    const after = colon >= 0 ? line.slice(colon + 1).trim() : line;
    const controller = /^(?:VGA compatible controller|3D controller|Display controller):\s*(.+)$/i.exec(
      after,
    );
    if (controller) return controller[1].trim();
  }
  return null;
}

function parseWindowsGpu(out) {
  if (!out) return null;
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.toLowerCase().startsWith('name')) continue;
    if (line.toLowerCase().startsWith('adapterram')) continue;
    return line;
  }
  return null;
}

async function getDeviceInfo() {
  const platform = os.platform();
  const cpus = os.cpus() || [];
  const cpuModel = cpus[0]?.model?.trim() || 'Unknown';
  const storagePath = rootStoragePath(platform);
  const fs = await statfsSafe(storagePath);
  const memoryBytes = os.totalmem();

  return {
    os: classifyOs(platform),
    osLabel: osLabel(platform, os.release(), os.version()),
    arch: os.arch(),
    hostname: os.hostname(),
    model: cpuModel,
    cpuCores: cpus.length,
    cpuPhysicalCores: cpus.length || 0,
    memoryBytes,
    storageBytes: fs?.total ?? 0,
    storageFreeBytes: fs?.free ?? 0,
    storagePath,
    gpu: probeGpu(platform),
  };
}

module.exports = { getDeviceInfo };
