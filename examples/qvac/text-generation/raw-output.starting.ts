import { loadModel, completion, unloadModel, QWEN3_600M_INST_Q4 } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({ modelSrc: QWEN3_600M_INST_Q4 });

  // 1: define PERSON_SCHEMA as a JSON Schema

  // 2: call completion() with responseFormat and stream contentDelta events

  // 3: after the loop, await result.final and JSON.parse

  await unloadModel({ modelId });
}

main().catch(console.error);