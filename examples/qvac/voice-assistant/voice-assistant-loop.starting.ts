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

const SYSTEM_PROMPT =
  "You are a concise, friendly voice assistant. Keep responses under two sentences. " +
  "Never use markdown, lists, or code blocks. Your output will be spoken aloud.";

async function main() {
  // 1: load the three models (ASR, LLM, TTS)

  // 2: declare history with the system prompt

  // 3: run the main loop

  await unloadModel({ modelId: ttsModelId });
  await unloadModel({ modelId: llmModelId });
  await unloadModel({ modelId: asrModelId });
}

main().catch(console.error);