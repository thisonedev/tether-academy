import { loadModel, completion, LLAMA_3_2_1B_INST_Q4_0 } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    modelConfig: { device: "gpu", ctx_size: 2048 },
  });

  const history: Array<{ role: string; content: string }> = [
    { role: "user", content: "What is the capital of France?" },
  ];

  const r1 = completion({ modelId, history, stream: true, kvCache: true });
  for await (const token of r1.tokenStream) {
    process.stdout.write(token);
  }
  const final1 = await r1.final;

  history.push({
    role: "assistant",
    content: final1.cacheableAssistantContent ?? final1.contentText,
  });
  history.push({ role: "user", content: "What about Germany?" });

  const r2 = completion({ modelId, history, stream: true, kvCache: true });
  for await (const token of r2.tokenStream) {
    process.stdout.write(token);
  }
  const final2 = await r2.final;

  console.log("\n▸ First turn stats:", JSON.stringify(final1.stats));
  console.log("▸ Second turn stats (cached):", JSON.stringify(final2.stats));
}

main().catch(console.error);