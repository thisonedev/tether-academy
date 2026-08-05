'use strict';

// Unpackaged Electron.app always reports CFBundleName "Electron" at launch
// and quit; app.setName/dock.setIcon only repaint the already-running app,
// too late for the OS's own icon. Fix: duplicate Electron.app, patch its
// Info.plist, swap the icon. No signing, no installer.
// Cached under home()/app-bundle, rebuilt when Electron's version changes.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { home } = require('./home');

const APP_NAME = 'Tether Academy';
const BUNDLE_ID = 'com.tether-academy.desktop';

function bundleDir() {
  return path.join(home(), 'app-bundle', `${APP_NAME}.app`);
}

function sourceElectronApp(desktopDir) {
  return path.join(desktopDir, 'node_modules', 'electron', 'dist', 'Electron.app');
}

function readVersion(appPath) {
  try {
    return execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(appPath, 'Contents', 'Info.plist')], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

function buildIcns(iconPngPath, destIcns) {
  const tmpIconset = `${destIcns}.iconset`;
  fs.rmSync(tmpIconset, { recursive: true, force: true });
  fs.mkdirSync(tmpIconset, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    execFileSync('sips', ['-z', String(size), String(size), iconPngPath, '--out', path.join(tmpIconset, `icon_${size}x${size}.png`)]);
    const double = size * 2;
    execFileSync('sips', ['-z', String(double), String(double), iconPngPath, '--out', path.join(tmpIconset, `icon_${size}x${size}@2x.png`)]);
  }
  execFileSync('iconutil', ['-c', 'icns', tmpIconset, '-o', destIcns]);
  fs.rmSync(tmpIconset, { recursive: true, force: true });
}

function patchPlist(plistPath, iconFileName) {
  const set = (key, value) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plistPath]);
  set('CFBundleName', APP_NAME);
  set('CFBundleDisplayName', APP_NAME);
  set('CFBundleIconFile', iconFileName);
  set('CFBundleIdentifier', BUNDLE_ID);
}

/**
 * Builds (or reuses a cached) rebranded copy of Electron.app for `desktopDir`.
 * Returns the path to its executable, or null if branding isn't applicable
 * (non-macOS, or the source Electron.app can't be found/copied).
 */
function ensureBrandedApp(desktopDir) {
  if (process.platform !== 'darwin') return null;
  const src = sourceElectronApp(desktopDir);
  if (!fs.existsSync(src)) return null;

  const dest = bundleDir();
  const destExe = path.join(dest, 'Contents', 'MacOS', 'Electron');
  const versionStamp = path.join(path.dirname(dest), '.electron-version');
  const srcVersion = readVersion(src);

  const stale = !fs.existsSync(destExe) || !fs.existsSync(versionStamp) || fs.readFileSync(versionStamp, 'utf8').trim() !== srcVersion;
  if (!stale) return destExe;

  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(src, dest, { recursive: true });

    const iconPng = path.join(desktopDir, 'assets', 'icon.png');
    const icnsName = 'tether-academy.icns';
    if (fs.existsSync(iconPng)) {
      buildIcns(iconPng, path.join(dest, 'Contents', 'Resources', icnsName));
    }
    patchPlist(path.join(dest, 'Contents', 'Info.plist'), icnsName);
    if (srcVersion) fs.writeFileSync(versionStamp, srcVersion, 'utf8');
    return destExe;
  } catch (err) {
    console.warn(`tether-academy: could not build branded app bundle (${err.message}); falling back to plain Electron.`);
    return null;
  }
}

module.exports = { ensureBrandedApp };
