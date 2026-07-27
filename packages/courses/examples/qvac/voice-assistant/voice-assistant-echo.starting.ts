import { spawn, spawnSync } from "node:child_process";
import { platform } from "node:os";
import {
  loadModel,
  unloadModel,
  transcribeStream,
  completion,
  textToSpeech,
  WHISPER_TINY,
  VAD_SILERO_5_1_2,
  LLAMA_3_2_1B_INST_Q4_0,
  TTS_EN_SUPERTONIC_Q8_0,
} from "@qvac/sdk";

const MIC_SAMPLE_RATE = 16000;
const TTS_SAMPLE_RATE = 44100;
const POST_PLAYBACK_COOLDOWN_MS = 300;
const MIN_UTTERANCE_CHARS = 3;

const SYSTEM_PROMPT =
  "You are a concise, friendly voice assistant. Keep responses under two sentences. " +
  "Never use markdown, lists, or code blocks. Your output will be spoken aloud.";

async function main() {
  await unloadModel({ modelId: ttsModelId });
  await unloadModel({ modelId: llmModelId });
  await unloadModel({ modelId: asrModelId });
}

main().catch(console.error);
