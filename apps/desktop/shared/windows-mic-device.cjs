// ffmpeg's dshow input has no "default device" concept, unlike avfoundation's
// `:0` or pulse's `default`. Every mic lesson needs a literal device name on
// Windows; this detects one so the user never has to run the listing by hand.
'use strict';

const { spawnSync } = require('child_process');

// ffmpeg 6+ tags each device inline: `[in#0 @ ...] "name" (audio)`, no
// section header. Older builds instead group devices under a
// "DirectShow audio devices" header with a bare `"name"` line per device.
// Both formats are handled since the installed ffmpeg version isn't known.
const INLINE_TAG_RE = /"([^"]+)"\s*\(audio\)\s*$/;
const AUDIO_SECTION_RE = /DirectShow audio devices/;
const SECTION_DEVICE_RE = /^\[dshow[^\]]*\]\s+"([^"]+)"\s*$/;
const ALT_NAME_RE = /Alternative name/;

function parseFirstAudioDevice(stderr) {
  const lines = stderr.split(/\r?\n/);

  for (const line of lines) {
    const match = INLINE_TAG_RE.exec(line);
    if (match) return match[1];
  }

  // The section-header format puts an "Alternative name" line right after
  // each device name; skip those, and stop at the first line that is
  // neither, since that marks the end of the audio section.
  const sectionIndex = lines.findIndex((l) => AUDIO_SECTION_RE.test(l));
  if (sectionIndex === -1) return null;
  for (let i = sectionIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (ALT_NAME_RE.test(line)) continue;
    const match = SECTION_DEVICE_RE.exec(line);
    if (match) return match[1];
    if (line.trim().length > 0) break;
  }
  return null;
}

let cached;

function detectWindowsMicDevice() {
  if (cached !== undefined) return cached;
  try {
    const result = spawnSync('ffmpeg', ['-f', 'dshow', '-list_devices', 'true', '-i', 'dummy'], {
      timeout: 5_000,
      windowsHide: true,
    });
    cached = parseFirstAudioDevice(result.stderr ? result.stderr.toString() : '');
  } catch {
    cached = null;
  }
  return cached;
}

module.exports = { detectWindowsMicDevice, parseFirstAudioDevice };
