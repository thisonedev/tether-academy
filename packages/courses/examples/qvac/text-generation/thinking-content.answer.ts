import { loadModel, completion, QWEN3_600M_INST_Q4 } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({
    modelSrc: QWEN3_600M_INST_Q4,
    modelConfig: { ctx_size: 4096 },
  });

  const result = completion({
    modelId,
    history: [
      { role: "user", content: "Why is the sky blue?" },
    ],
    stream: true,
    captureThinking: true,
  });

  for await (const event of result.events) {
    if (event.type === "thinkingDelta") {
    } else if (event.type === "contentDelta") {
      process.stdout.write(event.text);
    } else if (event.type === "completionStats") {
      process.stdout.write(
        `\n▸ done (${event.stats.generatedTokens ?? "?"} tokens, ${event.stats.tokensPerSecond?.toFixed(2) ?? "?"} tok/s)\n`,
      );
    }
  }

  const final = await result.final;
  if (final.thinkingText) {
    process.stderr.write(`▸ Thinking:\n${final.thinkingText.trim()}\n`);
  }
}

main().catch(console.error);
