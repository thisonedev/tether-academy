import {
  loadModel,
  unloadModel,
  GTE_LARGE_FP16,
  ragIngest,
  ragDeleteWorkspace,
} from "@qvac/sdk";

async function main() {
  const workspace = "delete-workspace-demo";
  const samples = [
    "A temporary workspace holds documents we want to remove in one go.",
  ];

  const modelId = await loadModel({ modelSrc: GTE_LARGE_FP16 });

  // 1: call ragIngest() into the workspace

  // 2: call ragDeleteWorkspace() to drop it

  void ragIngest;
  void ragDeleteWorkspace;

  await unloadModel({ modelId });
}

main().catch(console.error);