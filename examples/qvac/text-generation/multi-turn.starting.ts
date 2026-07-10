import { loadModel, completion, unloadModel, QWEN3_600M_INST_Q4 } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({ modelSrc: QWEN3_600M_INST_Q4 });

  // 1: declare `history` with the first user turn

  // 2: run the first completion() and push the assistant's reply into history

  // 3: push the next user turn and run a second completion() against the same history

  await unloadModel({ modelId });
}

main().catch(console.error);