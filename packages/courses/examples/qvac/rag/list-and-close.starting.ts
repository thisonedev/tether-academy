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
  // 1: loop through workspaces and log name + open status

  // 2: call ragCloseWorkspace with deleteOnClose: true

  await ragCloseWorkspace({ workspace });
  console.log(`Closed ${workspace}`);
}

main().catch(console.error);