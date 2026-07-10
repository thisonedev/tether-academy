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

const history: Array<{
  role: "system" | "user" | "assistant";
  content: string;
}> = [{ role: "system", content: SYSTEM_PROMPT }];

console.log("▸ Listening. Speak a question and pause. Ctrl+C to quit.\n");

for await (const rawText of transcribeStream({ modelId: asrModelId })) {
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
    await ttsResult.buffer;
  }
  console.log("\n▸ Listening...\n");
}

await unloadModel({ modelId: ttsModelId });
await unloadModel({ modelId: llmModelId });
await unloadModel({ modelId: asrModelId });
