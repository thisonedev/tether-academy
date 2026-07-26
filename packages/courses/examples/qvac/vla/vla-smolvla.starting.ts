import {
  close,
  loadModel,
  SMOLVLA_LIBERO_VISION_Q8,
  unloadModel,
  vla,
  vlaHparams,
  vlaPadState,
  vlaPreprocessImage,
} from "@qvac/sdk";

async function main() {
  // 1: load SmolVLA

  // 2: call vlaHparams to read the hparams

  // 3: build synthetic inputs (two camera frames, BOS-only tokens, zero state, zero noise)

  // 4: call vla() and log the action chunk + per-stage timings

  await unloadModel({ modelId: "", clearStorage: false });
  void close();
}

main().catch(console.error);