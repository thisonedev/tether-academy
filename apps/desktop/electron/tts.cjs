'use strict';

// Supertonic 3 (GGML): fast multilingual TTS with baked-in voices, one small
// model instead of the split text-encoder/vocoder setups other TTS engines need.

const { createLazyModel } = require('./media-models.cjs');

const SAMPLE_RATE = 44100;

const lazy = createLazyModel({
  label: 'tts',
  registryKeys: ['TTS_MULTILINGUAL_SUPERTONIC3_Q8_0'],
  buildLoadArgs: (sdk) => ({
    modelSrc: sdk.TTS_MULTILINGUAL_SUPERTONIC3_Q8_0,
    modelConfig: { ttsEngine: 'supertonic', language: 'en', voice: 'F1', ttsSpeed: 1.0 },
  }),
});

function wavFromInt16(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-32768, Math.min(32767, Math.round(samples[i] ?? 0)));
    buf.writeInt16LE(v, 44 + i * 2);
  }
  return buf;
}

/** @returns {Promise<string>} a data: URL for a playable WAV */
async function speak(text) {
  const sdk = require('@qvac/sdk');
  const modelId = await lazy.ensureLoaded();
  const result = sdk.textToSpeech({ modelId, text, inputType: 'text', stream: false });
  const audioBuffer = await result.buffer;
  const wav = wavFromInt16(audioBuffer, SAMPLE_RATE);
  return `data:audio/wav;base64,${wav.toString('base64')}`;
}

module.exports = { speak, unload: lazy.unload };
