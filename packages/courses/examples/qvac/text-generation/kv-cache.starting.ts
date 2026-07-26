import { loadModel, completion, unloadModel, LLAMA_3_2_1B_INST_Q4_0 } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    modelConfig: { device: "gpu", ctx_size: 2048 },
  });

  const history: Array<{ role: string; content: string }> = [
    { role: "user", content: "What is the capital of France?" },
  ];

  // 1: first turn, completion() with kvCache: true, drain tokenStream, await final

  // 2: push the assistant turn into history and append the next user turn

  // 3: second turn, completion() again with kvCache: true, log both stats

  await unloadModel({ modelId });
}

main().catch(console.error);