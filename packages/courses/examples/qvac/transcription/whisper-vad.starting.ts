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

const modelId = await loadModel({
  modelSrc: WHISPER_TINY,
  modelConfig: {
    vadModelSrc: VAD_SILERO_5_1_2,
    audio_format: "f32le",
    language: "en",
  },
});

const ffmpeg = startMicrophone(MIC_SAMPLE_RATE);

// 1: open a transcribeStream session with emitVadEvents and endOfTurnSilenceMs,
//    then pipe ffmpeg.stdout into session.write

// 2: switch on event.type for text, vad, endOfTurn, printing vad only on a change

// 3: close the session and unload the model on SIGINT/SIGTERM

await unloadModel({ modelId });
