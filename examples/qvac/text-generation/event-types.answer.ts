import { loadModel, completion, QWEN3_600M_INST_Q4 } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({ modelSrc: QWEN3_600M_INST_Q4 });

  const result = completion({
    modelId,
    history: [{ role: "user", content: "What is the capital of France?" }],
    stream: true,
    captureThinking: true,
  });

  console.log("▸ Streaming...");
  for await (const event of result.events) {
    switch (event.type) {
      case "contentDelta":
        process.stdout.write(event.text);
        break;
      case "thinkingDelta":
        process.stderr.write(`[think] ${event.text}`);
        break;
      case "completionDone":
        break;
    }
  }

  console.log();
  const final = await result.final;
  console.log(`▸ Final contentText: ${final.contentText}`);
  console.log(`▸ Stop reason: ${final.stopReason}`);
}

main().catch(console.error);