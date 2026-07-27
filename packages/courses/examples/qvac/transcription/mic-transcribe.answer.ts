import { spawn, spawnSync } from "node:child_process";
import { platform } from "node:os";
import { loadModel, unloadModel, transcribeStream, WorkerShutdownError, WHISPER_TINY, VAD_SILERO_5_1_2 } from "@qvac/sdk";

const MIC_SAMPLE_RATE = 16000;

const ffmpegCheck = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
if (ffmpegCheck.error || ffmpegCheck.status !== 0) {
  console.error("✖ ffmpeg not found on PATH. Install ffmpeg and retry.");
  process.exit(1);
}

type MicFormat = "f32le" | "s16le";

function getAudioInputArgs(): string[] {
  const override = process.env.MIC_DEVICE;
  switch (platform()) {
    case "darwin":
      return ["-f", "avfoundation", "-i", override ?? ":0"];
    case "linux":
      return ["-f", "pulse", "-i", override ?? "default"];
    case "win32":
      if (!override) {
        throw new Error(
          "Set MIC_DEVICE=<name> on Windows. Run `ffmpeg -f dshow -list_devices true -i dummy` to list devices.",
        );
      }
      return ["-f", "dshow", "-i", `audio=${override}`];
    default:
      throw new Error(`Unsupported platform: ${platform()}`);
  }
}

function startMicrophone(options: { sampleRate: number; format: MicFormat }) {
  const formatArgs =
    options.format === "f32le"
      ? ["-sample_fmt", "flt", "-f", "f32le"]
      : ["-sample_fmt", "s16", "-f", "s16le"];
  const ffmpeg = spawn(
    "ffmpeg",
    [
      ...getAudioInputArgs(),
      "-ar",
      String(options.sampleRate),
      "-ac",
      "1",
      ...formatArgs,
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  if (!ffmpeg.stdout) throw new Error("Failed to open microphone");
  return ffmpeg;
}

console.log("▸ Loading whisper-tiny + Silero VAD...");
const modelId = await loadModel({
  modelSrc: WHISPER_TINY,
  modelConfig: {
    vadModelSrc: VAD_SILERO_5_1_2,
    audio_format: "f32le",
    language: "en",
  },
});

console.log("▸ All models loaded.\n");

const ffmpeg = startMicrophone({ sampleRate: MIC_SAMPLE_RATE, format: "f32le" });
const session = await transcribeStream({ modelId, metadata: true });

ffmpeg.stdout.on("data", (chunk: Buffer) => {
  try { session.write(chunk); } catch {}
});

let shuttingDown = false;
async function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n\n▸ Stopping...");
  ffmpeg.kill();
  try { session.end(); } catch {}
  await unloadModel({ modelId }).catch(() => {});
  console.log("▸ Done.");
  process.exit(0);
}

process.on("SIGINT", () => void cleanup());
process.on("SIGTERM", () => void cleanup());

process.on("uncaughtException", (err) => {
  if (err instanceof WorkerShutdownError) return;
  if (err?.code === "CHANNEL_CLOSED") return;
  throw err;
});

console.log("▸ Listening... speak and pause to see transcriptions.\n");

for await (const segment of session) {
  const start = (segment.startMs / 1000).toFixed(2);
  const end = (segment.endMs / 1000).toFixed(2);
  console.log(`[${start}s → ${end}s] ${segment.text}`);
}

await cleanup();
