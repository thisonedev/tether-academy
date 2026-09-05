'use strict';

// Image and video generation, both through the SDK's sdcpp-generation engine.
// Each entry in IMAGE_MODELS/VIDEO_MODELS is one selectable option in the
// playground's "Model" field.

const { createLazyModel } = require('./media-models.cjs');

const IMAGE_MODELS = {
  'sd2.1': {
    label: 'Stable Diffusion 2.1 (2.3GB, fast)',
    registryKeys: ['SD_V2_1_1B_Q8_0'],
    buildLoadArgs: (sdk) => ({
      modelSrc: sdk.SD_V2_1_1B_Q8_0,
      modelType: 'sdcpp-generation',
      modelConfig: { prediction: 'v' },
    }),
  },
  'flux2-klein': {
    label: 'FLUX.2 [klein] (higher quality, slower)',
    registryKeys: ['FLUX_2_KLEIN_4B_Q4_0', 'QWEN3_4B_Q4_K_M', 'FLUX_2_KLEIN_4B_VAE'],
    buildLoadArgs: (sdk) => ({
      modelSrc: sdk.FLUX_2_KLEIN_4B_Q4_0,
      modelType: 'sdcpp-generation',
      modelConfig: { llmModelSrc: sdk.QWEN3_4B_Q4_K_M, vaeModelSrc: sdk.FLUX_2_KLEIN_4B_VAE },
    }),
    // FLUX's guidance-distilled sampling needs its own cfg_scale/guidance
    // pair; SD 2.1's classifier-free defaults would wash the image out.
    genArgs: { guidance: 3.5, cfg_scale: 1 },
  },
};

const VIDEO_MODELS = {
  'wan2.1-1.3b': {
    label: 'Wan 2.1 T2V 1.3B (14.5GB, slow: minutes per clip)',
    registryKeys: ['WAN2_1_T2V_1_3B_FP16', 'UMT5_XXL_FP16', 'WAN_2_1_COMFYUI_REPACKAGED_VAE'],
    buildLoadArgs: (sdk) => ({
      modelSrc: sdk.WAN2_1_T2V_1_3B_FP16,
      modelType: 'sdcpp-generation',
      modelConfig: {
        mode: 'video',
        device: 'gpu',
        t5XxlModelSrc: sdk.UMT5_XXL_FP16,
        vaeModelSrc: sdk.WAN_2_1_COMFYUI_REPACKAGED_VAE,
        diffusion_fa: true,
        offload_to_cpu: true,
        vae_on_cpu: true,
        vae_tiling: true,
      },
    }),
  },
};

const imageLazyByKey = new Map();
const videoLazyByKey = new Map();

function lazyFor(registry, byKeyMap, key, label) {
  const entry = registry[key];
  if (!entry) throw new Error(`unknown model "${key}"`);
  if (!byKeyMap.has(key)) {
    byKeyMap.set(
      key,
      createLazyModel({ label: `${label}:${key}`, registryKeys: entry.registryKeys, buildLoadArgs: entry.buildLoadArgs }),
    );
  }
  return byKeyMap.get(key);
}

function listImageModels() {
  return Object.entries(IMAGE_MODELS).map(([key, v]) => ({ key, label: v.label }));
}

function listVideoModels() {
  return Object.entries(VIDEO_MODELS).map(([key, v]) => ({ key, label: v.label }));
}

async function generateImage(prompt, modelKey) {
  const key = modelKey && IMAGE_MODELS[modelKey] ? modelKey : Object.keys(IMAGE_MODELS)[0];
  const sdk = require('@qvac/sdk');
  const modelId = await lazyFor(IMAGE_MODELS, imageLazyByKey, key, 'image').ensureLoaded();
  const { outputs } = sdk.diffusion({ modelId, prompt, ...IMAGE_MODELS[key].genArgs });
  const buffers = await outputs;
  const png = buffers[0];
  return `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
}

let currentVideoRequestId = null;

/** Runs a short (17-frame) clip and returns its bytes; the SDK's own docs say
 *  this engine typically writes AVI. Callers should expect this to take
 *  minutes, not seconds. See `cancelVideo` for stopping one mid-generation. */
async function generateVideo(prompt, modelKey, frames, steps) {
  const key = modelKey && VIDEO_MODELS[modelKey] ? modelKey : Object.keys(VIDEO_MODELS)[0];
  const sdk = require('@qvac/sdk');
  const modelId = await lazyFor(VIDEO_MODELS, videoLazyByKey, key, 'video').ensureLoaded();
  const { requestId, outputs } = sdk.video({
    modelId,
    mode: 'txt2vid',
    prompt,
    negative_prompt: 'blurry, low quality, static, jittery, watermark',
    width: 480,
    height: 832,
    video_frames: frames || 17,
    fps: 16,
    steps: steps || 30,
    cfg_scale: 6.0,
    flow_shift: 3.0,
    seed: 42,
    vae_tiling: true,
  });
  currentVideoRequestId = requestId;
  try {
    const buffers = await outputs;
    const video = buffers[0];
    return `data:video/avi;base64,${Buffer.from(video).toString('base64')}`;
  } finally {
    currentVideoRequestId = null;
  }
}

/** Cancels whatever video generation is in flight. The playground's Stop
 *  button calls this unconditionally, so a no-op (nothing running) must be safe. */
async function cancelVideo() {
  if (!currentVideoRequestId) return;
  const sdk = require('@qvac/sdk');
  await sdk.cancel({ requestId: currentVideoRequestId }).catch(() => {});
}

async function unloadAll() {
  for (const lazy of imageLazyByKey.values()) await lazy.unload();
  for (const lazy of videoLazyByKey.values()) await lazy.unload();
}

module.exports = { listImageModels, listVideoModels, generateImage, generateVideo, cancelVideo, unload: unloadAll };
