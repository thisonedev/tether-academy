import { loadModel, completion, LLAMA_3_2_1B_INST_Q4_0 } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({ modelSrc: LLAMA_3_2_1B_INST_Q4_0 });

  // 1: build a history array with one user message

  // 2: call completion() with stream: true

  // 3: iterate result.tokenStream and write each token to stdout
}

main().catch(console.error);