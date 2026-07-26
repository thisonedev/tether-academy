import {
  close,
  loadModel,
  PI05_BASE_Q_AGGRESSIVE,
  unloadModel,
  vla,
  vlaHparams,
  vlaPreprocessImage,
} from "@qvac/sdk";

const modelSrc = PI05_BASE_Q_AGGRESSIVE;

console.log("▸ Loading π₀.₅ model...");
const modelId = await loadModel({
  modelSrc,
  modelType: "ggml-vla",
  modelConfig: { backend: "cpu" },
  onProgress: (p) => {
    const mb = (n: number) => (n / 1e6).toFixed(1);
    const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`;
    process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
    if (p.percentage >= 100) process.stderr.write("\n");
  },
});
console.log(`▸ Model loaded: ${modelId}`);

const { hparams, backendName } = await vlaHparams({ modelId });
console.log(`▸ Backend: ${backendName ?? "(unknown)"}`);

const size = hparams.visionImageSize;
const numCameras = hparams.numCameras ?? 3;
const dummyPixels = new Uint8Array(size * size * 3).fill(128);

const images = Array.from({ length: numCameras }, () =>
  vlaPreprocessImage(dummyPixels, size, size, { size }),
);

const tokens = new Int32Array(hparams.tokenizerMaxLength);
const mask = new Uint8Array(hparams.tokenizerMaxLength);
tokens[0] = 1;
mask[0] = 1;

const state = new Float32Array(0);
const noise = new Float32Array(hparams.chunkSize * hparams.maxActionDim);

console.log("▸ Running VLA inference...");
const { actions, actionDim, chunkSize, stats } = await vla({
  modelId,
  images,
  imgWidth: size,
  imgHeight: size,
  state,
  tokens,
  mask,
  noise,
});

console.log(`▸ Got ${chunkSize} action steps of dim ${actionDim}.`);
console.log(Array.from(actions.subarray(0, actionDim)));
if (stats) {
  console.log(
    `▸ Timing: vision=${stats.vision_ms?.toFixed(0)}ms ` +
      `prefill=${stats.prefill_total_ms?.toFixed(0)}ms ` +
      `ode=${stats.ode_ms?.toFixed(0)}ms ` +
      `total=${stats.total_ms?.toFixed(0)}ms`,
  );
}

await unloadModel({ modelId, clearStorage: false });
void close();
