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

  await ragIngest({ modelId, workspace, documents: samples, chunk: false });
  console.log(`▸ Created workspace '${workspace}' with ${samples.length} document`);

  await ragDeleteWorkspace({ workspace });
  console.log(`▸ Deleted workspace '${workspace}' and its on-disk files`);

  await unloadModel({ modelId });
}

main().catch(console.error);
