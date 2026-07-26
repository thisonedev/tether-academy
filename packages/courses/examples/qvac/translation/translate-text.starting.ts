import { loadModel, translate, unloadModel, BERGAMOT_EN_FR } from "@qvac/sdk";

async function main() {
  // 1: load the Bergamot EN-FR model

  // 2: call translate(), await result.text, log the result

  await unloadModel({ modelId });
}

main().catch(console.error);