import { loadModel, GTE_LARGE_FP16, ragIngest, ragListWorkspaces, ragCloseWorkspace } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({ modelSrc: GTE_LARGE_FP16 });

  const workspace = "recipes";
  await ragIngest({
    modelId,
    workspace,
    documents: ["Peanut butter sandwich recipe"],
    chunk: false,
  });

  const workspaces = await ragListWorkspaces();

  console.log("Workspaces:");
  for (const ws of workspaces) {
    console.log(`▸ ${ws.name} (${ws.open ? "open" : "closed"})`);
  }

  await ragCloseWorkspace({ workspace, deleteOnClose: true });
  console.log(`▸ Deleted '${workspace}' workspace`);
}

main().catch(console.error);