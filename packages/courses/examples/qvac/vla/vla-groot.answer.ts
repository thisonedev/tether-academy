import {
  close,
  loadModel,
  GROOT_MULTI_Q8_VF16,
  unloadModel,
  vla,
  vlaHparams,
  vlaSetEmbodiment,
  vlaPadState,
} from "@qvac/sdk";

const IMAGE_TOKEN_ID = 151655;
const MERGED_TOKENS_PER_IMAGE = 64;
const TEXT_TOKEN_ID = 1000;
const PROMPT_TEXT_TAIL = 20;

console.log("▸ Loading GR00T (multi-embodiment) model...");
const modelId = await loadModel({
  modelSrc: GROOT_MULTI_Q8_VF16,
  modelType: "ggml-vla",
  modelConfig: { backend: "cpu", embodiment: "libero_sim" },
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
console.log(`▸ Embodiment: ${hparams.selectedEmbodimentTag} (${hparams.numCameras} cameras)`);

const numCameras = hparams.numCameras ?? 2;
const images = Array.from({ length: numCameras }, () =>
  new Float32Array(hparams.imagePatchElems!).fill(0.02),
);
const state = vlaPadState([0, 0, 0, 0, 0, 0], hparams.maxStateDim);
const noise = new Float32Array(hparams.chunkSize * hparams.maxActionDim);

const promptLength = numCameras * (MERGED_TOKENS_PER_IMAGE + 1) + PROMPT_TEXT_TAIL;
const tokens = new Int32Array(promptLength);
let w = 0;
for (let cam = 0; cam < numCameras; cam++) {
  for (let k = 0; k < MERGED_TOKENS_PER_IMAGE; k++) tokens[w++] = IMAGE_TOKEN_ID;
  tokens[w++] = TEXT_TOKEN_ID + cam;
}
for (; w < tokens.length; w++) tokens[w] = TEXT_TOKEN_ID + w;
const mask = new Uint8Array(promptLength).fill(1);

console.log("▸ Running VLA inference...");
const { actions, actionDim, chunkSize, stats } = await vla({
  modelId,
  images,
  imgWidth: hparams.visionImageSize,
  imgHeight: hparams.visionImageSize,
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
      `ode=${stats.ode_ms?.toFixed(0)}ms ` +
      `total=${stats.total_ms?.toFixed(0)}ms`,
  );
}

console.log("▸ Switching embodiment to real_droid...");
const { hparams: refreshed } = await vlaSetEmbodiment({ modelId, embodiment: "real_droid" });
console.log(`▸ Embodiment: ${refreshed.selectedEmbodimentTag} (${refreshed.numCameras} cameras)`);

await unloadModel({ modelId, clearStorage: false });
void close();
