import {
  loadModel,
  unloadModel,
  transcribe,
  PARAKEET_TDT_0_6B_V3_Q8_0,
  PARAKEET_SORTFORMER_4SPK_V2_1_Q8_0,
} from "@qvac/sdk";

async function main() {
  const audioFilePath = "./examples/audio/diarization-sample-16k.wav";

  const sfModelId = await loadModel({
    modelSrc: PARAKEET_SORTFORMER_4SPK_V2_1_Q8_0,
    modelType: "parakeet-transcription",
  });

  const diarization = await transcribe({
    modelId: sfModelId,
    audioChunk: audioFilePath,
  });
  await unloadModel({ modelId: sfModelId });

  const segments = diarization
    .split("\n")
    .map((line) => line.match(/Speaker (\d+): ([\d.]+)s - ([\d.]+)s/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ speaker: +m[1]!, start: +m[2]!, end: +m[3]! }))
    .sort((a, b) => a.start - b.start);

  const tdtModelId = await loadModel({
    modelSrc: PARAKEET_TDT_0_6B_V3_Q8_0,
    modelType: "parakeet-transcription",
  });

  const results: { speaker: number; start: number; end: number; text: string }[] = [];
  for (const seg of segments) {
    const text = await transcribe({
      modelId: tdtModelId,
      audioChunk: audioFilePath,
    });
    results.push({ ...seg, text });
  }

  await unloadModel({ modelId: tdtModelId });

  for (const r of results) {
    console.log(
      `Speaker ${r.speaker} (${r.start.toFixed(2)}s - ${r.end.toFixed(2)}s): ${r.text}`,
    );
  }
}

main().catch(console.error);
