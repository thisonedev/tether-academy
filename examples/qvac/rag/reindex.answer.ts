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

  const result = await ragReindex({ modelId, workspace });

  console.log("Reindexed:", result.reindexed);
  if (!result.reindexed) {
    console.log("Reason:", result.details?.reason ?? "unknown");
  }

  await ragCloseWorkspace({ workspace });
}

main().catch(console.error);
