import { loadModel, unloadModel, transcribe, PARAKEET_TDT_0_6B_V3_Q8_0 } from "@qvac/sdk";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";

const SAMPLE_RATE = 16000;
const SILENCE_NOISE_DB = -35;
const SILENCE_DURATION_S = 0.5;
const MIN_SEGMENT_S = 10;
const TARGET_SEGMENT_S = 45;
const MAX_SEGMENT_S = 60;

interface CommandResult {
  stdout: Buffer;
  stderr: string;
}

interface SilenceInterval {
  start: number;
  end: number;
}

interface AudioSegment {
  start: number;
  end: number;
}

function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const stderrText = Buffer.concat(stderr).toString();
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code}: ${stderrText.trim()}`));
        return;
      }
      resolve({ stdout: Buffer.concat(stdout), stderr: stderrText });
    });
  });
}

async function getAudioDuration(audioPath: string): Promise<number> {
  const result = await runCommand("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    audioPath,
  ]);
  const duration = Number.parseFloat(result.stdout.toString().trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Could not determine audio duration for ${audioPath}`);
  }
  return duration;
}

async function detectSilences(audioPath: string, duration: number): Promise<SilenceInterval[]> {
  const result = await runCommand("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-i",
    audioPath,
    "-vn",
    "-af",
    `silencedetect=noise=${SILENCE_NOISE_DB}dB:d=${SILENCE_DURATION_S}`,
    "-f",
    "null",
    "-",
  ]);

  const intervals: SilenceInterval[] = [];
  let currentStart: number | null = null;

  for (const line of result.stderr.split("\n")) {
    const startMatch = line.match(/silence_start:\s*([0-9.]+)/);
    if (startMatch?.[1]) {
      const start = Number.parseFloat(startMatch[1]);
      if (Number.isFinite(start)) currentStart = start;
    }
    const endMatch = line.match(/silence_end:\s*([0-9.]+)/);
    if (endMatch?.[1] && currentStart !== null) {
      const end = Number.parseFloat(endMatch[1]);
      if (Number.isFinite(end) && end > currentStart) {
        intervals.push({ start: currentStart, end });
      }
      currentStart = null;
    }
  }

  if (currentStart !== null && currentStart < duration) {
    intervals.push({ start: currentStart, end: duration });
  }
  return intervals;
}

function createAudioSegments(duration: number, silences: SilenceInterval[]): AudioSegment[] {
  const silenceMidpoints = silences.map(({ start, end }) => start + (end - start) / 2);
  const segments: AudioSegment[] = [];
  let start = 0;

  while (duration - start > MAX_SEGMENT_S) {
    const target = start + TARGET_SEGMENT_S;
    const minimumCut = start + MIN_SEGMENT_S;
    const maximumCut = start + MAX_SEGMENT_S;
    const candidates = silenceMidpoints.filter(
      (candidate) => candidate >= minimumCut && candidate <= maximumCut,
    );
    const firstCandidate = candidates[0];
    const cut =
      firstCandidate === undefined
        ? Math.min(target, duration - MIN_SEGMENT_S)
        : candidates.slice(1).reduce((best, candidate) => {
            return Math.abs(candidate - target) < Math.abs(best - target)
              ? candidate
              : best;
          }, firstCandidate);

    segments.push({ start, end: cut });
    start = cut;
  }
  if (duration > start) {
    segments.push({ start, end: duration });
  }
  return segments;
}

async function decodeSegment(audioPath: string, segment: AudioSegment): Promise<Buffer> {
  const result = await runCommand("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    segment.start.toFixed(3),
    "-i",
    audioPath,
    "-t",
    (segment.end - segment.start).toFixed(3),
    "-vn",
    "-ar",
    String(SAMPLE_RATE),
    "-ac",
    "1",
    "-sample_fmt",
    "s16",
    "-f",
    "s16le",
    "pipe:1",
  ]);
  return result.stdout;
}

function formatTimestamp(seconds: number): string {
  const totalTenths = Math.round(seconds * 10);
  const hours = Math.floor(totalTenths / 36000);
  const minutes = Math.floor((totalTenths % 36000) / 600);
  const remainingSeconds = ((totalTenths % 600) / 10).toFixed(1).padStart(4, "0");
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${remainingSeconds}`;
}

const audioFilePath =
  process.argv[2] ?? "./examples/qvac/transcription/input/sample-16khz.wav";
if (!fs.existsSync(audioFilePath)) {
  console.error(`✖ ${audioFilePath} does not exist`);
  console.error(`Usage: tsx <file>.ts <audio-file>`);
  process.exit(1);
}

// Gate on ffmpeg and ffprobe at startup. spawnSync's error.code is the
// canonical check for "not on PATH"; a non-zero exit is a different problem.
for (const tool of ["ffmpeg", "ffprobe"]) {
  const check = spawnSync(tool, ["-version"], { stdio: "ignore" });
  if (check.error?.code === "ENOENT") {
    console.error(`✖ ${tool} not found on PATH`);
    process.exit(1);
  }
}

const duration = await getAudioDuration(audioFilePath);
const silences = await detectSilences(audioFilePath, duration);
const segments = createAudioSegments(duration, silences);

const modelId = await loadModel({
  modelSrc: PARAKEET_TDT_0_6B_V3_Q8_0,
  modelType: "parakeet-transcription",
});

const transcript: string[] = [];
for (const [index, segment] of segments.entries()) {
  console.log(
    `▸ Segment ${index + 1}/${segments.length}: ${formatTimestamp(segment.start)} - ${formatTimestamp(segment.end)}`,
  );
  const audioChunk = await decodeSegment(audioFilePath, segment);
  const text = await transcribe({ modelId, audioChunk });
  const normalized = text.trim();
  if (normalized.length > 0 && !normalized.includes("[No speech detected]")) {
    transcript.push(normalized);
    console.log(normalized);
  }
}

console.log("\n▸ Complete transcript");
console.log(transcript.join(" "));

await unloadModel({ modelId });
console.log("▸ Done");