'use strict';

const test = require('brittle');
const { parseFirstAudioDevice } = require('../../shared/windows-mic-device.cjs');

const REALISTIC_STDERR = `ffmpeg version 6.0
  built with gcc
[dshow @ 000001d6a4f3f280] DirectShow video devices (some may be both video and audio devices)
[dshow @ 000001d6a4f3f280]  "Integrated Webcam"
[dshow @ 000001d6a4f3f280]    Alternative name "@device_pnp_\\\\?\\usb#vid_0000"
[dshow @ 000001d6a4f3f280] DirectShow audio devices
[dshow @ 000001d6a4f3f280]  "Microphone (Realtek(R) Audio)"
[dshow @ 000001d6a4f3f280]    Alternative name "@device_cm_{...}\\wave_{...}"
dummy: Immediate exit requested
`;

// Captured from a real ffmpeg 7.x build on the Windows test VM.
const REAL_VM_STDERR = `ffmpeg version 7.1
  libavdevice    63.  1.101 / 63.  1.101
[in#0 @ 0000029b0dec6640] Could not enumerate video devices (or none found).
[in#0 @ 0000029b0dec6640] "Line In (High Definition Audio Device)" (audio)
[in#0 @ 0000029b0dec6640]   Alternative name "@device_cm_{...}\\wave_{...}"
`;

test('windows-mic-device - picks the first real audio device (legacy section-header format), skipping the alternative-name line', (t) => {
  t.is(parseFirstAudioDevice(REALISTIC_STDERR), 'Microphone (Realtek(R) Audio)');
});

test('windows-mic-device - picks the first real audio device (ffmpeg 7.x inline-tag format)', (t) => {
  t.is(parseFirstAudioDevice(REAL_VM_STDERR), 'Line In (High Definition Audio Device)');
});

test('windows-mic-device - no audio section returns null', (t) => {
  t.is(parseFirstAudioDevice('[dshow @ x] DirectShow video devices\n[dshow @ x]  "Integrated Webcam"\n'), null);
});

test('windows-mic-device - empty input returns null', (t) => {
  t.is(parseFirstAudioDevice(''), null);
});

test('windows-mic-device - "no devices found" after the section header returns null', (t) => {
  const stderr = '[dshow @ x] DirectShow audio devices\n[dshow @ x]  Could not enumerate audio devices (or none found).\n';
  t.is(parseFirstAudioDevice(stderr), null);
});
