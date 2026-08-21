import {
  loadModel,
  unloadModel,
  transcribeStream,
  PARAKEET_SORTFORMER_4SPK_V2_1_Q8_0,
} from "@qvac/sdk";
import { spawn } from "node:child_process";
import fs from "node:fs";

const SAMPLE_RATE = 16000;
const BYTES_PER_S16_SAMPLE = 2;
const STREAM_CHUNK_MS = 2000;
const TRAILING_SILENCE_MS = 1500;

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

const audioFilePath =
  process.argv[2] ?? "./examples/qvac/transcription/input/diarization-sample-16k.wav";
if (!fs.existsSync(audioFilePath)) {
  console.error(`✖ ${audioFilePath} does not exist`);
  console.error(`Usage: tsx <file>.ts <path-to-wav>`);
  process.exit(1);
}

const chunkBytes =
  Math.floor((STREAM_CHUNK_MS / 1000) * SAMPLE_RATE) * BYTES_PER_S16_SAMPLE;

function readS16leFromWav(wavPath: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const proc = spawn(
      "ffmpeg",
      [
        "-i",
        wavPath,
        "-ar",
        String(SAMPLE_RATE),
        "-ac",
        "1",
        "-f",
        "s16le",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    proc.stdout.on("data", (buf: Buffer) => chunks.push(buf));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}`));
        return;
      }
      const merged = Buffer.concat(chunks);
      resolve(
        new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength),
      );
    });
  });
}

const modelId = await loadModel({
  modelSrc: PARAKEET_SORTFORMER_4SPK_V2_1_Q8_0,
  modelType: "parakeet-transcription",
  modelConfig: { ...SORTFORMER_V21_AOSC_LOAD_CONFIG },
});

const session = await transcribeStream({
  modelId,
  parakeetStreamingConfig: { chunkMs: STREAM_CHUNK_MS },
});

const pcm = await readS16leFromWav(audioFilePath);
const trailingSilenceBytes = new Uint8Array(
  Math.floor((TRAILING_SILENCE_MS / 1000) * SAMPLE_RATE) * BYTES_PER_S16_SAMPLE,
);

for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
  const end = Math.min(offset + chunkBytes, pcm.length);
  session.write(pcm.subarray(offset, end));
  if (end < pcm.length) {
    await new Promise((resolve) => setTimeout(resolve, STREAM_CHUNK_MS));
  }
}

for (let offset = 0; offset < trailingSilenceBytes.length; offset += chunkBytes) {
  const end = Math.min(offset + chunkBytes, trailingSilenceBytes.length);
  session.write(trailingSilenceBytes.subarray(offset, end));
  if (end < trailingSilenceBytes.length) {
    await new Promise((resolve) => setTimeout(resolve, STREAM_CHUNK_MS));
  }
}

session.end();

const lines: string[] = [];
for await (const event of session) {
  if (event.type === "text") {
    const trimmed = event.text.trim();
    if (trimmed.length > 0) {
      lines.push(trimmed);
    }
  }
}

console.log("\n▸ Streaming diarization transcript");
console.log(lines.join("\n") || "(no speaker lines emitted)");

await unloadModel({ modelId }).catch(() => {});