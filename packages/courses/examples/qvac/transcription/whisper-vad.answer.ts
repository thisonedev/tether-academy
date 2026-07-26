import { loadModel, unloadModel, transcribeStream, WHISPER_TINY, VAD_SILERO_5_1_2 } from "@qvac/sdk";

async function audioStream(): Promise<Float32Array[]> {
  const frames: Float32Array[] = [];
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 100));
    frames.push(new Float32Array(16000));
  }
  return frames;
}

async function main() {
  console.log("▸ Loading whisper-tiny + Silero VAD...");
  const modelId = await loadModel({
    modelSrc: WHISPER_TINY,
    modelConfig: {
      vadModelSrc: VAD_SILERO_5_1_2,
      language: "en",
    },
  });
  console.log("▸ Model loaded.\n");

  const session = await transcribeStream({
    modelId,
    emitVadEvents: true,
    endOfTurnSilenceMs: 800,
  });

  void (async () => {
    for (const chunk of await audioStream()) {
      session.write(chunk);
    }
  })();

  console.log("▸ Listening...\n");
  for await (const event of session) {
    switch (event.type) {
      case "text":
        console.log(`> ${event.text.trim()}`);
        break;
      case "vad":
        console.log(
          `▸ [vad] speaking=${event.speaking} probability=${event.probability.toFixed(2)}`,
        );
        break;
      case "endOfTurn":
        console.log(`▸ [endOfTurn] silence ${event.silenceDurationMs}ms\n`);
        break;
    }
  }

  await unloadModel({ modelId });
}

main().catch(console.error);
