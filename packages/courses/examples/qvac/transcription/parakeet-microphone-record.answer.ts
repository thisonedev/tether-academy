import { loadModel, unloadModel, transcribe, PARAKEET_TDT_0_6B_V3_Q8_0 } from "@qvac/sdk";
import { spawn, spawnSync } from "node:child_process";
import { platform } from "node:os";

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const CHUNK_DURATION_S = 3;
const CHUNK_SIZE = SAMPLE_RATE * BYTES_PER_SAMPLE * CHUNK_DURATION_S;

const ffmpegCheck = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
if (ffmpegCheck.error || ffmpegCheck.status !== 0) {
  console.error("✖ ffmpeg not found on PATH. Install ffmpeg and retry.");
  process.exit(1);
}

function startMicrophone(options: { sampleRate: number; format: "s16le" }) {
  const override = process.env.MIC_DEVICE;
  let inputArgs: string[];
  switch (platform()) {
    case "darwin":
      inputArgs = ["-f", "avfoundation", "-i", override ?? ":0"];
      break;
    case "linux":
      inputArgs = ["-f", "pulse", "-i", override ?? "default"];
      break;
    case "win32":
      if (!override) {
        throw new Error(
          "Set MIC_DEVICE=<name> on Windows. Run `ffmpeg -f dshow -list_devices true -i dummy` to list devices.",
        );
      }
      inputArgs = ["-f", "dshow", "-i", `audio=${override}`];
      break;
    default:
      throw new Error(`Unsupported platform: ${platform()}`);
  }
  const ffmpeg = spawn(
    "ffmpeg",
    [
      ...inputArgs,
      "-ar",
      String(options.sampleRate),
      "-ac",
      "1",
      "-sample_fmt",
      "s16",
      "-f",
      options.format,
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  if (!ffmpeg.stdout) throw new Error("Failed to open microphone");
  return ffmpeg;
}

const modelId = await loadModel({
  modelSrc: PARAKEET_TDT_0_6B_V3_Q8_0,
  modelType: "parakeet-transcription",
});

const ffmpeg = startMicrophone({ sampleRate: SAMPLE_RATE, format: "s16le" });

let buffer = Buffer.alloc(0);
let processing = false;

console.log("▸ Listening... speak and pause to see transcriptions.\n");

let primed = false;
ffmpeg.stdout.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  if (buffer.length < CHUNK_SIZE || processing) return;

  if (!primed) {
    primed = true;
    console.log("▸ Ready. Speak into the mic.\n");
  }

  const audioChunk = buffer.subarray(0, CHUNK_SIZE);
  buffer = buffer.subarray(CHUNK_SIZE);
  processing = true;

  void (async () => {
    try {
      const text = await transcribe({ modelId, audioChunk });
      const trimmed = text.trim();
      if (trimmed.length > 0 && !trimmed.includes("[No speech detected]")) {
        console.log(trimmed);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/shutting down/i.test(msg) && !/in-flight rpc/i.test(msg)) {
        console.error("✖", msg);
      }
    } finally {
      processing = false;
    }
  })();
});

let shuttingDown = false;
async function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n\n▸ Stopping...");
  ffmpeg.kill();
  await unloadModel({ modelId }).catch(() => {});
  console.log("▸ Done.");
  process.exit(0);
}

process.on("SIGINT", () => void cleanup());
process.on("SIGTERM", () => void cleanup());