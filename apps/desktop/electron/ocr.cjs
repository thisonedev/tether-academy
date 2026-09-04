'use strict';

// Real text-from-image via the SDK's ggml-ocr addon (doctr-based detector +
// recognizer, OCR_LATIN). image arrives from the renderer as a data URL;
// the SDK itself accepts a Buffer directly, no temp file needed.

const { createLazyModel } = require('./media-models.cjs');

const lazy = createLazyModel({
  label: 'ocr',
  registryKeys: ['OCR_LATIN'],
  buildLoadArgs: (sdk) => ({
    modelSrc: sdk.OCR_LATIN,
    modelConfig: { langList: ['en'] },
  }),
});

function bufferFromDataUrl(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Buffer.from(base64, 'base64');
}

async function readTextFromImage(imageDataUrl) {
  const sdk = require('@qvac/sdk');
  const modelId = await lazy.ensureLoaded();
  const { blocks } = sdk.ocr({ modelId, image: bufferFromDataUrl(imageDataUrl) });
  const result = await blocks;
  return result.map((b) => b.text).join('\n');
}

module.exports = { readTextFromImage, unload: lazy.unload };
