import { loadModel, unloadModel, transcribeStream, WHISPER_TINY, VAD_SILERO_5_1_2 } from "@qvac/sdk";
import { spawn } from "node:child_process";

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 4;
const CHUNK_SIZE = Math.floor(0.1 * SAMPLE_RATE) * BYTES_PER_SAMPLE;

const WHISPER_TINY_F32LE_LOAD_CONFIG = {
  vadModelSrc: VAD_SILERO_5_1_2,
  audio_format: "f32le",
  strategy: "greedy",
  n_threads: 4,
  language: "en",
  no_timestamps: true,
  suppress_blank: true,
  suppress_nst: true,
  temperature: 0.0,
  vad_params: {
    threshold: 0.6,
    min_speech_duration_ms: 250,
    min_silence_duration_ms: 500,
    max_speech_duration_s: 15.0,
    speech_pad_ms: 200,
  },
} as const;

const audioFilePath = process.argv[2] ?? "./examples/qvac/transcription/input/sample-16khz.wav";

const modelId = await loadModel({
  modelSrc: WHISPER_TINY,
  modelConfig: WHISPER_TINY_F32LE_LOAD_CONFIG,
});

const session = await transcribeStream({ modelId, metadata: true });

const ffmpeg = spawn(
  "ffmpeg",
  [
    "-i",
    audioFilePath,
    "-ar",
    String(SAMPLE_RATE),
    "-ac",
    "1",
    "-sample_fmt",
    "flt",
    "-f",
    "f32le",
    "pipe:1",
  ],
  { stdio: ["ignore", "pipe", "ignore"] },
);

let totalBytes = 0;
ffmpeg.stdout.on("data", (raw: Buffer) => {
  for (let offset = 0; offset < raw.length; offset += CHUNK_SIZE) {
    const chunk = raw.subarray(offset, offset + CHUNK_SIZE);
    session.write(chunk);
    totalBytes += chunk.length;
  }
});

ffmpeg.on("close", () => {
  const durationSec = totalBytes / (SAMPLE_RATE * BYTES_PER_SAMPLE);
  console.log(`▸ Audio streamed: ${totalBytes} bytes (~${durationSec.toFixed(1)}s)`);
  session.end();
});

const segments: { text: string; startMs: number; endMs: number; id: number; append: boolean }[] = [];
for await (const segment of session) {
  segments.push(segment);
  const start = (segment.startMs / 1000).toFixed(2);
  const end = (segment.endMs / 1000).toFixed(2);
  console.log(
    `▸ [${segments.length}] [${start}s → ${end}s] (id=${segment.id}, append=${segment.append}) ${segment.text.trim()}`,
  );
}

console.log(`\n▸ Segments: ${segments.length}`);
if (segments.length > 0) {
  console.log(segments.map((s) => s.text.trim()).join(" "));
} else {
  console.log("▸ No transcription segments received!");
}

await unloadModel({ modelId });
console.log("▸ Done.");