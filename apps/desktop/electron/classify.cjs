'use strict';

// Bundled 3-class MobileNetV3 classifier (@qvac/classification-ggml ships its
// own weights, no registry download): food / report / other.

const { createLazyModel } = require('./media-models.cjs');

const lazy = createLazyModel({
  label: 'classify',
  buildLoadArgs: () => ({ modelType: 'ggml-classification' }),
});

function bufferFromDataUrl(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Buffer.from(base64, 'base64');
}

async function classifyImage(imageDataUrl) {
  const sdk = require('@qvac/sdk');
  const modelId = await lazy.ensureLoaded();
  const results = await sdk.classify({ modelId, image: bufferFromDataUrl(imageDataUrl) });
  return results.map(({ label, confidence }) => `${label}: ${(confidence * 100).toFixed(1)}%`).join('\n');
}

module.exports = { classifyImage, unload: lazy.unload };
