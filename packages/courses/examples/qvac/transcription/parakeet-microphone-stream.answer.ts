import { loadModel, unloadModel, transcribeStream, PARAKEET_EOU_120M_V1_Q8_0 } from "@qvac/sdk";
import { spawn, spawnSync } from "node:child_process";
import { platform } from "node:os";

const SAMPLE_RATE = 16000;

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

const modelId = await loadModel({ modelSrc: PARAKEET_EOU_120M_V1_Q8_0 });

const ffmpeg = startMicrophone({ sampleRate: SAMPLE_RATE, format: "s16le" });

const session = await transcribeStream({
  modelId,
  parakeetStreamingConfig: {
    chunkMs: 1000,
    emitPartials: true,
  },
});

ffmpeg.stdout.on("data", (chunk: Buffer) => {
  try {
    session.write(chunk);
  } catch {
    // session.write throws during teardown; swallow it.
  }
});

let shuttingDown = false;
async function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n▸ Stopping...");
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

console.log(
  "▸ Listening... speak and pause to see transcripts. End-of-turn boundaries fire when the EOU model emits an <EOU> token.\n",
);

// Debounce partials so a fast follow-up replaces the previous text instead
// of racing stdout.
const PARTIAL_DEBOUNCE_MS = 80;
let pendingText: string | null = null;
let pendingTimer: NodeJS.Timeout | null = null;

// Collapse runs of whitespace the tokenizer leaves in raw partials.
function collapseSpacing(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function flushPending() {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  if (pendingText !== null) {
    process.stdout.write(`\n${collapseSpacing(pendingText)}`);
    pendingText = null;
  }
}

function schedulePartial(text: string) {
  const cleaned = collapseSpacing(text);
  if (cleaned.length === 0) return;
  pendingText = cleaned;
  if (pendingTimer) return;
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    if (pendingText !== null) {
      process.stdout.write(`\n${pendingText}`);
      pendingText = null;
    }
  }, PARTIAL_DEBOUNCE_MS);
}

for await (const event of session) {
  if (event.type === "text") {
    const trimmed = event.text.trim();
    if (trimmed.length > 0) {
      schedulePartial(event.text);
    }
  } else if (event.type === "endOfTurn") {
    flushPending();
    console.log("\n▸ [endOfTurn] turn boundary detected");
  }
}