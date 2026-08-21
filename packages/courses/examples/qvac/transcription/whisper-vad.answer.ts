import { spawn, spawnSync } from "node:child_process";
import { platform } from "node:os";
import { loadModel, unloadModel, transcribeStream, WHISPER_TINY, VAD_SILERO_5_1_2 } from "@qvac/sdk";

const MIC_SAMPLE_RATE = 16000;

const ffmpegCheck = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
if (ffmpegCheck.error || ffmpegCheck.status !== 0) {
  console.error("✖ ffmpeg not found on PATH. Install ffmpeg and retry.");
  process.exit(1);
}

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

function startMicrophone(sampleRate: number) {
  const ffmpeg = spawn(
    "ffmpeg",
    [
      ...getAudioInputArgs(),
      "-ar",
      String(sampleRate),
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
  if (!ffmpeg.stdout) throw new Error("Failed to open microphone");
  return ffmpeg;
}

console.log("▸ Loading whisper-tiny + Silero VAD...");
const modelId = await loadModel({
  modelSrc: WHISPER_TINY,
  modelConfig: {
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
      min_silence_duration_ms: 300,
      max_speech_duration_s: 15.0,
      speech_pad_ms: 100,
    },
  },
});
console.log("▸ Model loaded.\n");

const ffmpeg = startMicrophone(MIC_SAMPLE_RATE);

const session = await transcribeStream({
  modelId,
  emitVadEvents: true,
  endOfTurnSilenceMs: 800,
});

let shuttingDown = false;

ffmpeg.stdout.on("data", (chunk: Buffer) => {
  if (shuttingDown) return;
  try {
    session.write(chunk);
  } catch {}
});

async function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n\n▸ Stopping...");
  ffmpeg.kill();
  try {
    session.end();
  } catch {}
  await unloadModel({ modelId }).catch(() => {});
  console.log("▸ Done.");
  process.exit(0);
}

process.on("SIGINT", () => void cleanup());
process.on("SIGTERM", () => void cleanup());

console.log("▸ Listening...\n");

let lastSpeaking = false;
try {
  for await (const event of session) {
    switch (event.type) {
      case "text":
        console.log(`> ${event.text.trim()}`);
        break;
      case "vad":
        if (event.speaking !== lastSpeaking) {
          console.log(
            `▸ [vad] speaking=${event.speaking} probability=${event.probability.toFixed(2)}`,
          );
          lastSpeaking = event.speaking;
        }
        break;
      case "endOfTurn":
        console.log(`▸ [endOfTurn] silence ${event.silenceDurationMs}ms\n`);
        break;
    }
  }
} catch (err) {
  if (!shuttingDown) throw err;
}

await cleanup();
