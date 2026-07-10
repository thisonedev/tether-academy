import {
  completion,
  loadModel,
  QWEN3_600M_INST_Q4,
} from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({
    modelSrc: QWEN3_600M_INST_Q4,
    modelConfig: { ctx_size: 4096 },
  });
  console.log(`▸ Model loaded: ${modelId}`);

  const result = completion({
    modelId,
    history: [
      { role: "user", content: "Explain quantum computing in 2 sentences" },
    ],
    stream: true,
    captureThinking: true,
  });

  for await (const event of result.events) {
    switch (event.type) {
      case "contentDelta":
        process.stdout.write(event.text);
        break;
      case "thinkingDelta":
        process.stderr.write(`[think] ${event.text}`);
        break;
      case "completionStats":
        if (event.stats.tokensPerSecond !== undefined) {
          console.log(`\n▸ ${event.stats.tokensPerSecond.toFixed(0)} tok/s`);
        }
        break;
    }
  }
}

main().catch(console.error);