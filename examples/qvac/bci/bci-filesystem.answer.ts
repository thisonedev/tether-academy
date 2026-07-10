import {
  loadModel,
  unloadModel,
  bciTranscribe,
  BCI_WINDOWED,
} from "@qvac/sdk";

const neuralFilePath = process.argv[2] ?? "./examples/bci/input/sample.bin";

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

console.log(`▸ BCI model loaded with ID: ${modelId}`);

console.log("▸ Transcribing neural signal...");
const segments = await bciTranscribe({
  modelId,
  neuralData: neuralFilePath,
  metadata: true,
});

for (const segment of segments) {
  const start = (segment.startMs / 1000).toFixed(2);
  const end = (segment.endMs / 1000).toFixed(2);
  console.log(
    `  [${start}s → ${end}s] (id=${segment.id}, append=${segment.append}) ${segment.text}`,
  );
}

await unloadModel({ modelId });
