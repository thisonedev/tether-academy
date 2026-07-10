import { loadModel, GTE_LARGE_FP16, ragIngest, ragReindex, ragCloseWorkspace } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({ modelSrc: GTE_LARGE_FP16 });
  const workspace = "tiny";

  await ragIngest({
    modelId,
    workspace,
    documents: ["only one document, not enough for clustering"],
    chunk: false,
  });

  // 1: call ragReindex() and log the result (with reason when reindexed is false)

  await ragCloseWorkspace({ workspace });
}

main().catch(console.error);