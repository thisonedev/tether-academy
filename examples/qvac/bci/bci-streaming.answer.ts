import {
  loadModel,
  unloadModel,
  bciTranscribeStream,
  BCI_WINDOWED,
} from "@qvac/sdk";
import { readFileSync } from "node:fs";

const neuralFilePath = process.argv[2] ?? "./examples/bci/input/sample.bin";
const CHUNK_SIZE = 64 * 1024;

console.log("▸ Loading BCI model...");
const modelId = await loadModel({
  modelSrc: BCI_WINDOWED,
  modelConfig: {
    whisperConfig: {
      language: "en",
      n_threads: 4,
      temperature: 0.0,
    },
    bciConfig: {
      day_idx: 1,
    },
  },
});

const session = await bciTranscribeStream({ modelId, emit: "delta" });

// Drain the session concurrently with writing so the sliding-window
// decode can make progress as chunks arrive instead of stalling.
const consume = (async () => {
  for await (const text of session) {
    process.stdout.write(text);
  }
})();

const data = readFileSync(neuralFilePath);

for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
  const chunk = data.subarray(offset, offset + CHUNK_SIZE);
  session.write(chunk);
  await new Promise((resolve) => setTimeout(resolve, 10));
}

session.end();
await consume;

await unloadModel({ modelId });
