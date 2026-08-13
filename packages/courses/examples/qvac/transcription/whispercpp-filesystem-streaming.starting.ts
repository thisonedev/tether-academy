import { spawn } from "node:child_process";
import {
  loadModel,
  unloadModel,
  transcribeStream,
  WHISPER_TINY,
  VAD_SILERO_5_1_2,
} from "@qvac/sdk";

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

const audioFilePath =
  process.argv[2] ?? "./examples/qvac/transcription/input/sample-16khz.wav";

async function main() {
  // 1: load Whisper + VAD via WHISPER_TINY_F32LE_LOAD_CONFIG

  // 2: open a transcribeStream session

  // 3: pipe the WAV file through ffmpeg into session.write

  // 4: on ffmpeg close, session.end(), iterate segments, log, join, unload

  void modelId;
  await unloadModel({ modelId: "" });
}

main().catch(console.error);