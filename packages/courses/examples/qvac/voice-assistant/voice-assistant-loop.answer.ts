import { spawn, spawnSync } from "node:child_process";
import { platform } from "node:os";
import {
  loadModel,
  unloadModel,
  transcribeStream,
  completion,
  textToSpeech,
  WorkerShutdownError,
  WHISPER_TINY,
  VAD_SILERO_5_1_2,
  LLAMA_3_2_1B_INST_Q4_0,
  TTS_EN_SUPERTONIC_Q8_0,
} from "@qvac/sdk";

const MIC_SAMPLE_RATE = 16000;
const TTS_SAMPLE_RATE = 44100;

const SYSTEM_PROMPT =
  "You are a concise, friendly voice assistant. Keep responses under two sentences. " +
  "Never use markdown, lists, or code blocks. Your output will be spoken aloud.";

for (const tool of ["ffmpeg", "ffplay"]) {
  const r = spawnSync(tool, ["-version"], { stdio: "ignore" });
  if (r.error || r.status !== 0) {
    console.error(`✖ ${tool} not found on PATH. Install ffmpeg and retry.`);
    process.exit(1);
  }
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

function createWavHeader(dataLength: number, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataLength, 40);
  return header;
}

function int16ArrayToBuffer(samples: number[] | Int16Array): Buffer {
  const view = samples instanceof Int16Array ? samples : Int16Array.from(samples);
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}

function playAudio(wavBuffer: Buffer): void {
  const result = spawnSync(
    "ffplay",
    ["-hide_banner", "-loglevel", "error", "-autoexit", "-nodisp", "-i", "pipe:0"],
    { input: wavBuffer, stdio: ["pipe", "inherit", "inherit"] },
  );
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error("ffplay not found on PATH. Install ffmpeg and retry.");
    }
    throw new Error(`ffplay failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`ffplay exited with code ${result.status}`);
  }
}

console.log("▸ Loading whisper-tiny + Silero VAD...");
const asrModelId = await loadModel({
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
  },
});

console.log("▸ Loading Llama 3.2 1B...");
const llmModelId = await loadModel({
  modelSrc: LLAMA_3_2_1B_INST_Q4_0,
  modelConfig: {
    ctx_size: 4096,
  },
});

console.log("▸ Loading Supertonic TTS...");
const ttsModelId = await loadModel({
  modelSrc: TTS_EN_SUPERTONIC_Q8_0,
  modelConfig: {
    ttsEngine: "supertonic",
    language: "en",
    voice: "F1",
    ttsSpeed: 1.05,
    ttsNumInferenceSteps: 5,
  },
});

console.log("▸ All models loaded.\n");

const ffmpeg = startMicrophone({ sampleRate: MIC_SAMPLE_RATE, format: "f32le" });
const session = await transcribeStream({ modelId: asrModelId });

const history: Array<{
  role: "system" | "user" | "assistant";
  content: string;
}> = [{ role: "system", content: SYSTEM_PROMPT }];

ffmpeg.stdout.on("data", (chunk: Buffer) => {
  session.write(chunk);
});

let shuttingDown = false;
async function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n\n▸ Stopping...");
  ffmpeg.kill();
  try {
    session.end();
  } catch {}
  await unloadModel({ modelId: ttsModelId }).catch(() => {});
  await unloadModel({ modelId: llmModelId }).catch(() => {});
  await unloadModel({ modelId: asrModelId }).catch(() => {});
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

console.log("▸ Listening. Speak a question and pause. Ctrl+C to quit.\n");

for await (const rawText of session) {
  const userText = rawText.trim();
  if (userText.length === 0) continue;

  console.log(`▸ You: ${userText}`);
  history.push({ role: "user", content: userText });

  console.log("▸ Assistant:");
  const llmResult = completion({
    modelId: llmModelId,
    history,
    stream: true,
  });
  let assistantText = "";
  for await (const token of llmResult.tokenStream) {
    process.stdout.write(token);
    assistantText += token;
  }
  process.stdout.write("\n");
  history.push({ role: "assistant", content: assistantText });

  const spoken = assistantText.trim();
  if (spoken.length > 0) {
    const ttsResult = textToSpeech({
      modelId: ttsModelId,
      text: spoken,
      inputType: "text",
      stream: false,
    });
    const samples = await ttsResult.buffer;
    if (samples.length > 0) {
      const wavBuffer = Buffer.concat([
        createWavHeader(samples.length * 2, TTS_SAMPLE_RATE),
        int16ArrayToBuffer(samples),
      ]);
      playAudio(wavBuffer);
    }
  }
  console.log("\n▸ Listening...\n");
}

await cleanup();
