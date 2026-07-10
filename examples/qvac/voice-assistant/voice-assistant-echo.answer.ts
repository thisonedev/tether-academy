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

const POST_PLAYBACK_COOLDOWN_MS = 300;
const MIN_UTTERANCE_CHARS = 3;

const VAD_PARAMS = {
  threshold: 0.6,
  min_speech_duration_ms: 300,
  min_silence_duration_ms: 700,
  max_speech_duration_s: 15.0,
  speech_pad_ms: 200,
};

function isMeaningfulTranscript(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.includes("[No speech detected]")) return false;
  if (/^\[[^\]]+\]$/.test(trimmed)) return false;
  const letters = trimmed.replace(/[^\p{L}\p{N}]/gu, "");
  return letters.length >= MIN_UTTERANCE_CHARS;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    vad_params: VAD_PARAMS,
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

const SYSTEM_PROMPT =
  "You are a concise, friendly voice assistant. Keep responses under two sentences. " +
  "Never use markdown, lists, or code blocks. Your output will be spoken aloud.";

const history: Array<{
  role: "system" | "user" | "assistant";
  content: string;
}> = [{ role: "system", content: SYSTEM_PROMPT }];

let isSpeaking = false;

for await (const rawText of transcribeStream({ modelId: asrModelId })) {
  if (isSpeaking) continue;
  if (!isMeaningfulTranscript(rawText)) continue;
  const userText = rawText.trim();

  console.log(`▸ You: ${userText}`);
  history.push({ role: "user", content: userText });

  isSpeaking = true;
  try {
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
      await ttsResult.buffer;
      await sleep(POST_PLAYBACK_COOLDOWN_MS);
    }
  } finally {
    isSpeaking = false;
    console.log("\n▸ Listening...\n");
  }
}

await unloadModel({ modelId: ttsModelId });
await unloadModel({ modelId: llmModelId });
await unloadModel({ modelId: asrModelId });
