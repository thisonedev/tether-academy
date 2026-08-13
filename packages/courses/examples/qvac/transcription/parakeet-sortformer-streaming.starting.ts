import {
  loadModel,
  unloadModel,
  transcribeStream,
  PARAKEET_SORTFORMER_4SPK_V2_1_Q8_0,
} from "@qvac/sdk";

const SORTFORMER_V21_AOSC_LOAD_CONFIG = {
  streaming: true,
  streamingChunkMs: 2000,
  streamingChunkRightContextMs: 560,
  streamingSpkCacheEnable: true,
  streamingSpkCacheLen: 188,
  streamingFifoLen: 188,
  streamingChunkLeftContextMs: 80,
  streamingSpkCacheUpdatePeriod: 144,
} as const;

async function main() {
  // 1: load Sortformer v2.1 with the AOSC knobs in modelConfig

  // 2: open a transcribeStream session with parakeetStreamingConfig

  // 3: pipe a WAV file into the session in wall-clock-paced 2s chunks, then drain events

  void modelId;
  await unloadModel({ modelId: "" });
}

main().catch(console.error);