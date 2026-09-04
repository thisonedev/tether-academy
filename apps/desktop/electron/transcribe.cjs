'use strict';

// Real speech-to-text via whisper.cpp's WHISPER_TINY. Takes WAV bytes
// directly (the SDK accepts a Buffer for audioChunk, no temp file needed).

const { createLazyModel } = require('./media-models.cjs');

const lazy = createLazyModel({
  label: 'transcribe',
  registryKeys: ['WHISPER_TINY'],
  buildLoadArgs: (sdk) => ({
    modelSrc: sdk.WHISPER_TINY,
    modelConfig: { language: 'en' },
  }),
});

function bufferFromDataUrl(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Buffer.from(base64, 'base64');
}

async function transcribeAudio(audioDataUrl) {
  const sdk = require('@qvac/sdk');
  const modelId = await lazy.ensureLoaded();
  // metadata: false (the default) makes transcribe() resolve a plain string,
  // not the per-segment array metadata: true returns.
  const text = await sdk.transcribe({ modelId, audioChunk: bufferFromDataUrl(audioDataUrl) });
  return text.trim();
}

module.exports = { transcribeAudio, unload: lazy.unload };
