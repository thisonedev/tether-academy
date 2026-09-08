'use strict';

// Live mic capture + streaming transcription for the playground's Record
// voice node. Mirrors chat.cjs's requestId/EventEmitter shape, but the
// in-flight state is an ffmpeg child piping into a transcribeStream session.

const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { detectWindowsMicDevice } = require('../shared/windows-mic-device.cjs');
const { createLazyModel } = require('./media-models.cjs');

const lazy = createLazyModel({
  label: 'voice',
  modelName: 'Whisper Tiny',
  modelKind: 'voice',
  registryKeys: ['WHISPER_TINY', 'VAD_SILERO_5_1_2'],
  buildLoadArgs: (sdk) => ({
    modelSrc: sdk.WHISPER_TINY,
    // Streaming refuses to open without a VAD model: it decides when the
    // speaker paused long enough to commit a segment.
    modelConfig: {
      vadModelSrc: sdk.VAD_SILERO_5_1_2,
      audio_format: 'f32le',
      language: 'en',
      // Defaults commit a segment too eagerly for a multi-sentence turn;
      // min_silence_duration_ms is the one that matters, per the SDK's own
      // voice-assistant tuning guidance for this exact loop.
      vad_params: { threshold: 0.6, min_speech_duration_ms: 300, min_silence_duration_ms: 700, max_speech_duration_s: 15.0, speech_pad_ms: 200 },
    },
  }),
});

const events = new EventEmitter();
events.setMaxListeners(50);

// Keyed by requestId so stop() can end a session it doesn't otherwise hold a
// reference to.
const inflight = new Map();

const DEFAULT_MAX_DURATION_MS = 60_000;
// A memo runs across many pauses, not just one turn, so it gets a longer
// safety ceiling than the single-utterance default.
const DEFAULT_RECORDING_MAX_DURATION_MS = 5 * 60_000;
// Whisper's own streaming input has to be 16kHz; a memo's playback copy doesn't.
const RECORDING_SAMPLE_RATE = 48_000;

function emitEvent(payload) {
  events.emit('event', payload);
}

function onEvent(callback) {
  events.on('event', callback);
  return () => events.off('event', callback);
}

function newRequestId() {
  return `voice-${crypto.randomUUID()}`;
}

function ensureFfmpegAvailable() {
  const result = spawnSync('ffmpeg', ['-version']);
  if (result.error || result.status !== 0) {
    throw new Error('ffmpeg is required for voice recording but was not found on PATH.');
  }
}

// Ported from @qvac/sdk's own examples/audio mic helper, which isn't
// importable directly (outside the package's exports map). MIC_DEVICE
// overrides the default device on any platform.
function getAudioInputArgs() {
  const override = process.env.MIC_DEVICE;
  switch (process.platform) {
    case 'darwin':
      return ['-f', 'avfoundation', '-i', override || ':0'];
    case 'linux':
      return ['-f', 'pulse', '-i', override || 'default'];
    case 'win32': {
      const deviceName = override || detectWindowsMicDevice();
      if (!deviceName) {
        throw new Error(
          'No Windows audio input device found. List devices with ffmpeg -f dshow -list_devices true -i dummy, then set MIC_DEVICE.',
        );
      }
      return ['-f', 'dshow', '-i', `audio=${deviceName}`];
    }
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

// highpass drops room rumble/AC hum below where speech lives; afftdn is
// ffmpeg's own steady-state noise reducer. Kept conservative here since
// this same capture feeds the transcription, not just human ears.
const MIC_FILTERS = 'highpass=f=80,afftdn=nf=-25';

// Whisper needs 16kHz, while a memo people listen back to wants a higher rate.
// Two ffmpeg processes racing for the device left one tap silently empty, so
// asplit feeds both formats from a single open.
function startMicrophone(record) {
  const args = record
    ? [
        ...getAudioInputArgs(),
        '-filter_complex', `${MIC_FILTERS},asplit=2[a][b]`,
        '-map', '[a]', '-ar', '16000', '-ac', '1', '-sample_fmt', 'flt', '-f', 'f32le', 'pipe:1',
        '-map', '[b]', '-ar', String(RECORDING_SAMPLE_RATE), '-ac', '1', '-sample_fmt', 's16', '-f', 's16le', 'pipe:3',
      ]
    : [...getAudioInputArgs(), '-af', MIC_FILTERS, '-ar', '16000', '-ac', '1', '-sample_fmt', 'flt', '-f', 'f32le', 'pipe:1'];
  const ffmpeg = spawn('ffmpeg', args, {
    stdio: record ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
  });
  if (!ffmpeg.stdout || (record && !ffmpeg.stdio[3])) throw new Error('Failed to open the microphone.');
  let stderrTail = '';
  ffmpeg.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-2000);
  });
  return {
    ffmpeg,
    transcribeStream: ffmpeg.stdout,
    recordStream: record ? ffmpeg.stdio[3] : null,
    // The tail of ffmpeg's stderr, past its startup banner: the only place
    // that says why a device wouldn't open.
    lastError: () => stderrTail.split('\n').map((l) => l.trim()).filter(Boolean).slice(-2).join(' '),
  };
}

// How long capture gets to produce its first bytes. Silence still streams
// samples, so nothing at all past this means the device never opened.
const MIC_FIRST_AUDIO_MS = 5_000;

// ffmpeg dying (device busy, permission refused, a stale device index) was
// invisible: stderr went nowhere and nothing watched the child, so a dead
// mic left the conversation listening forever with no audio and no error.
function watchMicrophone(mic, onFailure) {
  mic.ffmpeg.on('error', (err) => onFailure(`Could not start microphone capture: ${err.message}`));
  mic.ffmpeg.on('exit', () => onFailure(`Microphone capture stopped. ${mic.lastError()}`.trim()));
  let bytes = 0;
  mic.transcribeStream.on('data', (chunk) => {
    bytes += chunk.length;
  });
  const firstAudio = setTimeout(() => {
    if (bytes === 0) onFailure(`The microphone produced no audio. ${mic.lastError()}`.trim());
  }, MIC_FIRST_AUDIO_MS);
  if (typeof firstAudio.unref === 'function') firstAudio.unref();
}

const NORMALIZE_TARGET = 0.97;
const NORMALIZE_MAX_GAIN = 8;

// A single fixed gain for the whole take, computed from its actual peak
// (only known once recording is done), so quiet audio gets loud without
// the noise-pumping an adaptive live normalizer causes during pauses.
function normalizePeak(pcm16) {
  let peak = 1;
  for (let i = 0; i < pcm16.length; i += 2) {
    const abs = Math.abs(pcm16.readInt16LE(i));
    if (abs > peak) peak = abs;
  }
  const gain = Math.min(NORMALIZE_MAX_GAIN, (32767 * NORMALIZE_TARGET) / peak);
  if (gain <= 1.02) return pcm16;
  const out = Buffer.alloc(pcm16.length);
  for (let i = 0; i < pcm16.length; i += 2) {
    const sample = Math.round(pcm16.readInt16LE(i) * gain);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i);
  }
  return out;
}

function pcm16ChunksToWavDataUrl(chunks, sampleRate) {
  const pcm16 = normalizePeak(Buffer.concat(chunks));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm16.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm16.length, 40);
  return `data:audio/wav;base64,${Buffer.concat([header, pcm16]).toString('base64')}`;
}

const DEFAULT_END_OF_TURN_MS = 1_500;
const STALE_MODEL_RE = /model.*not found/i;

// Opening a duplex against an already-loaded model is only a handshake, so
// this trips solely when the worker stops answering. That leaves the call
// pending forever, which reads as a mic that hears nothing.
const SESSION_OPEN_TIMEOUT_MS = 20_000;

function openTranscribeSession(sdk, params) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error('The transcription session never opened: the model worker stopped answering. Restart the app to clear it.'));
    }, SESSION_OPEN_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    sdk.transcribeStream(params).then(
      (session) => {
        clearTimeout(timer);
        // Arrived after we already gave up; nothing will ever read it.
        if (settled) {
          try {
            session.destroy();
          } catch {}
          return;
        }
        settled = true;
        resolve(session);
      },
      (err) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(err);
      },
    );
  });
}

async function start({ stopPhrase, maxDurationMs, record, endOfTurnSilenceMs }) {
  const sdk = require('@qvac/sdk');
  if (typeof sdk.transcribeStream !== 'function') {
    throw new Error('@qvac/sdk does not export transcribeStream in this build');
  }
  // No stop phrase by default: a recording ends on the Stop button (or
  // maxDurationMs), not a magic word, unless the caller opts into one.
  const phrase = stopPhrase ? stopPhrase.trim().toLowerCase() : null;
  const requestId = newRequestId();

  let ffmpeg = null;
  let session = null;
  let finished = false;
  const parts = [];
  const audioChunks = record ? [] : null;

  const defaultMs = record ? DEFAULT_RECORDING_MAX_DURATION_MS : DEFAULT_MAX_DURATION_MS;
  const deadline = setTimeout(() => finish(false), Math.max(1_000, maxDurationMs || defaultMs));
  if (typeof deadline.unref === 'function') deadline.unref();

  function finish(stoppedByPhrase, error) {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    inflight.delete(requestId);
    try {
      ffmpeg?.kill();
    } catch {}
    try {
      session?.destroy();
    } catch {}
    const audioDataUrl = audioChunks && audioChunks.length > 0 ? pcm16ChunksToWavDataUrl(audioChunks, RECORDING_SAMPLE_RATE) : null;
    emitEvent({ requestId, transcript: parts.join(' ').trim(), stoppedByPhrase, audioDataUrl, done: true, error: error ?? null });
  }

  inflight.set(requestId, () => finish(false));

  // Mic capture starts immediately and buffers until the session is open;
  // opening a session means loading the model first, which on a cold start
  // takes real time, and anything said in that window was previously lost.
  const mic = startMicrophone(record);
  ffmpeg = mic.ffmpeg;
  watchMicrophone(mic, (error) => finish(false, error));
  if (record) mic.recordStream.on('data', (chunk) => audioChunks.push(chunk));
  let sessionReady = false;
  const preBuffer = [];
  mic.transcribeStream.on('data', (chunk) => {
    if (!sessionReady) {
      preBuffer.push(chunk);
      return;
    }
    try {
      session.write(chunk);
    } catch {}
  });

  // A modelId evicted between turns fails with "not found". One retry isn't
  // enough when the cause is contention with the chat model over the same
  // worker, so give a transient conflict a couple of beats to clear.
  const MAX_ATTEMPTS = 3;
  async function openSession(attempt = 1) {
    try {
      const modelId = await lazy.ensureLoaded();
      return record
        ? await openTranscribeSession(sdk, { modelId })
        : await openTranscribeSession(sdk, { modelId, emitVadEvents: true, endOfTurnSilenceMs: endOfTurnSilenceMs || DEFAULT_END_OF_TURN_MS });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_ATTEMPTS && STALE_MODEL_RE.test(message)) {
        await lazy.unload().catch(() => {});
        await new Promise((r) => setTimeout(r, 300 * attempt));
        return openSession(attempt + 1);
      }
      // Which path handed out the broken id (cache, fresh load, adoption)
      // narrows down the real failure, and this text is the only diagnostic
      // that reaches the UI.
      throw new Error(`${message} (source=${lazy.getLastSource()}, attempt=${attempt}/${MAX_ATTEMPTS})`);
    }
  }

  (async () => {
    try {
      ensureFfmpegAvailable();
      const opened = await openSession();
      // Stop or the deadline can fire while the model is still loading, and
      // finish() already ran against a null session. Tearing this one down
      // too avoids a session left open with nothing feeding it.
      if (finished) {
        try {
          opened.destroy();
        } catch {}
        return;
      }
      session = opened;
      sessionReady = true;
      for (const chunk of preBuffer.splice(0)) {
        try {
          session.write(chunk);
        } catch {}
      }
      if (record) {
        // No emitVadEvents flag: the plain session yields one complete
        // string per VAD-detected pause, folded into the recording as it
        // goes rather than treated as the end of the whole session.
        for await (const rawText of session) {
          if (finished) break;
          const text = typeof rawText === 'string' ? rawText.trim() : '';
          if (!text) continue;
          const lower = text.toLowerCase();
          const isStopPhrase = phrase !== null && (lower === phrase || lower.endsWith(` ${phrase}`));
          if (isStopPhrase) {
            const stripped = text.slice(0, text.length - phrase.length).trim();
            if (stripped) parts.push(stripped);
            finish(true);
            return;
          }
          parts.push(text);
        }
      } else {
        // text events are one committed sentence, not the whole turn; only
        // endOfTurn (a real pause, not just the gap between two sentences)
        // means the speaker is actually done.
        for await (const event of session) {
          if (finished) break;
          if (event.type === 'text') {
            const text = event.text.trim();
            if (!text) continue;
            const lower = text.toLowerCase();
            const isStopPhrase = phrase !== null && (lower === phrase || lower.endsWith(` ${phrase}`));
            if (isStopPhrase) {
              const stripped = text.slice(0, text.length - phrase.length).trim();
              if (stripped) parts.push(stripped);
              finish(true);
              return;
            }
            parts.push(text);
          } else if (event.type === 'endOfTurn' && parts.length > 0) {
            finish(false);
            return;
          }
        }
      }
      finish(false);
    } catch (err) {
      finish(false, err instanceof Error ? err.message : String(err));
    }
  })();

  return { requestId };
}

function stop(requestId) {
  const fn = inflight.get(requestId);
  if (!fn) return false;
  fn();
  return true;
}

// Keyed by conversationId so stopConversation() can end one it doesn't
// otherwise hold a reference to (mirrors `inflight` above).
const conversations = new Map();

// One transcribeStream session for the whole conversation, yielding an event
// per turn. The SDK's voice-assistant lessons iterate a single session the
// same way; reopening one per turn caused "model not found" on a second turn.
async function startConversation({ endOfTurnSilenceMs }) {
  const sdk = require('@qvac/sdk');
  const conversationId = `conv-${crypto.randomUUID()}`;

  let ffmpeg = null;
  let session = null;
  let finished = false;
  let parts = [];

  function endConversation({ error = null, transcript = '' } = {}) {
    if (finished) return;
    finished = true;
    conversations.delete(conversationId);
    try {
      ffmpeg?.kill();
    } catch {}
    try {
      session?.destroy();
    } catch {}
    // Always emits, even on a clean explicit stop with nothing pending: the
    // renderer's turn loop is only listening for events, so a silent end
    // here (no error, nothing said) would leave it waiting forever.
    emitEvent({ conversationId, transcript, done: true, error });
  }

  conversations.set(conversationId, () => endConversation());

  const mic = startMicrophone(false);
  ffmpeg = mic.ffmpeg;
  watchMicrophone(mic, (error) => endConversation({ error }));
  let sessionReady = false;
  const preBuffer = [];
  mic.transcribeStream.on('data', (chunk) => {
    if (!sessionReady) {
      preBuffer.push(chunk);
      return;
    }
    try {
      session.write(chunk);
    } catch {}
  });

  (async () => {
    try {
      ensureFfmpegAvailable();
      const modelId = await lazy.ensureLoaded();
      const opened = await openTranscribeSession(sdk, {
        modelId,
        emitVadEvents: true,
        endOfTurnSilenceMs: endOfTurnSilenceMs || DEFAULT_END_OF_TURN_MS,
      });
      if (finished) {
        try {
          opened.destroy();
        } catch {}
        return;
      }
      session = opened;
      sessionReady = true;
      for (const chunk of preBuffer.splice(0)) {
        try {
          session.write(chunk);
        } catch {}
      }
      for await (const event of session) {
        if (finished) break;
        if (event.type === 'text') {
          const text = event.text.trim();
          if (!text) continue;
          parts.push(text);
        } else if (event.type === 'endOfTurn' && parts.length > 0) {
          const transcript = parts.join(' ').trim();
          parts = [];
          // done:false marks one finished turn, not the end of the
          // conversation: the same session keeps listening for the next one.
          emitEvent({ conversationId, transcript, done: false, error: null });
        }
      }
      endConversation();
    } catch (err) {
      endConversation({ error: err instanceof Error ? err.message : String(err) });
    }
  })();

  return { conversationId };
}

function stopConversation(conversationId) {
  const fn = conversations.get(conversationId);
  if (!fn) return false;
  fn();
  return true;
}

// Loads the model without opening the mic or a session, so a caller can have
// Whisper and the reply model both ready before recording starts.
async function preload() {
  await lazy.ensureLoaded();
}

module.exports = { start, stop, startConversation, stopConversation, preload, onEvent, unload: lazy.unload };
