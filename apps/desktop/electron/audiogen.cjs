'use strict';

// Music generation via ACE-Step (4 components: text encoder, LM, DiT, VAE),
// the SDK's own documented combo for its `audiogen` model type.

const { createLazyModel } = require('./media-models.cjs');

const lazy = createLazyModel({
  label: 'audiogen',
  registryKeys: [
    'AUDIOGEN_QWEN3_EMBEDDING_0_6B_Q8_0',
    'AUDIOGEN_ACESTEP_5HZ_LM_0_6B_Q8_0',
    'AUDIOGEN_ACESTEP_V15_TURBO_Q4_K_M',
    'AUDIOGEN_VAE_BF16',
  ],
  buildLoadArgs: (sdk) => ({
    modelType: 'audiogen',
    modelConfig: {
      textEncModelSrc: sdk.AUDIOGEN_QWEN3_EMBEDDING_0_6B_Q8_0,
      lmModelSrc: sdk.AUDIOGEN_ACESTEP_5HZ_LM_0_6B_Q8_0,
      ditModelSrc: sdk.AUDIOGEN_ACESTEP_V15_TURBO_Q4_K_M,
      vaeModelSrc: sdk.AUDIOGEN_VAE_BF16,
      useGPU: true,
      inferenceSteps: 8,
    },
  }),
});

function wavFromPcm(pcm, sampleRate, channels, bitsPerSample) {
  const blockAlign = channels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]);
}

/** @param {string} caption @param {number} [durationSec] */
async function generateMusic(caption, durationSec) {
  const sdk = require('@qvac/sdk');
  const modelId = await lazy.ensureLoaded();
  const run = sdk.audioGen({ modelId, caption, lyrics: '[Instrumental]', seed: 42, duration: durationSec ?? 10 });
  const { pcm, sampleRate, channels, bitsPerSample } = await run.audio;
  const wav = wavFromPcm(pcm, sampleRate, channels, bitsPerSample);
  return `data:audio/wav;base64,${wav.toString('base64')}`;
}

module.exports = { generateMusic, unload: lazy.unload };
