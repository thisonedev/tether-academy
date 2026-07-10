import {
  close,
  loadModel,
  PI05_BASE_Q_AGGRESSIVE,
  unloadModel,
  vla,
  vlaHparams,
  vlaPreprocessImage,
} from "@qvac/sdk";

async function main() {
  // 1: load π₀.₅ and read hparams

  // 2: build synthetic inputs from hparams

  // 3: call vla() and log the result

  await unloadModel({ modelId: "", clearStorage: false });
  void close();
}

main().catch(console.error);