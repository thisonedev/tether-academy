import { loadModel, completion, unloadModel, QWEN3_600M_INST_Q4 } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({ modelSrc: QWEN3_600M_INST_Q4 });

  const history = [
    { role: "user", content: "What is Bitcoin? One sentence." },
  ];

  // 1: fire two completion() calls in the same tick

  // 2: await them with Promise.all and read each .text

  // 3: log the result of each and a "Both completed." line

  await unloadModel({ modelId });
}

main().catch(console.error);