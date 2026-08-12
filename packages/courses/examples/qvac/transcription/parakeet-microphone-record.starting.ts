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

async function main() {
  // 1: load the Parakeet TDT model

  // 2: spawn ffmpeg and accumulate 3 s chunks, then transcribe each one

  // 3: wire SIGINT / SIGTERM to a cleanup that kills ffmpeg and unloads the model

  void modelId;
  await unloadModel({ modelId: "" });
}

main().catch(console.error);