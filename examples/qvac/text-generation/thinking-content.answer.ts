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
    switch (event.type) {
      case "contentDelta":
        process.stdout.write(event.text);
        break;
      case "thinkingDelta":
        process.stderr.write(`[think] ${event.text}`);
        break;
    }
  }

  const final = await result.final;
  if (final.thinkingText) {
    console.log(`\n▸ Thinking: ${final.thinkingText}`);
  }
}

main().catch(console.error);
