import { loadModel, completion, unloadModel, LLAMA_3_2_1B_INST_Q4_0 } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({ modelSrc: LLAMA_3_2_1B_INST_Q4_0 });

  const history = [
    { role: "user", content: "Explain quantum computing in one sentence" },
  ];
  const result = completion({ modelId, history, stream: true });
  for await (const token of result.tokenStream) {
    process.stdout.write(token);
  }

  await unloadModel({ modelId, autoClose: true });
  console.log("\n▸ model unloaded");
}

main().catch(console.error);