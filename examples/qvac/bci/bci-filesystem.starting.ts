import {
  loadModel,
  unloadModel,
  bciTranscribe,
  BCI_WINDOWED,
} from "@qvac/sdk";

const neuralFilePath = process.argv[2] ?? "./examples/bci/input/sample.bin";

async function main() {
  // 1: load the BCI model

  // 2: transcribe the file with metadata: true

  // 3: iterate segments and console.log each with timestamps

  await unloadModel({ modelId });
}

main().catch(console.error);