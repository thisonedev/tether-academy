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
  // 1: add vad_params to the ASR modelConfig
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
  const llmModelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    modelConfig: { ctx_size: 4096 },
  });
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

  const history: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }> = [{ role: "system", content: SYSTEM_PROMPT }];

  // 2: define helpers and isSpeaking flag

  // 3: run the new for-await loop

  await unloadModel({ modelId: ttsModelId });
  await unloadModel({ modelId: llmModelId });
  await unloadModel({ modelId: asrModelId });
}

main().catch(console.error);