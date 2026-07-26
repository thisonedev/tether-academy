import {
  loadModel,
  unloadModel,
  GTE_LARGE_FP16,
  ragIngest,
  ragCloseWorkspace,
} from "@qvac/sdk";

const workspace = "delete-workspace-demo";
const samples = [
  "A temporary workspace holds documents we want to remove in one go.",
];

const modelId = await loadModel({ modelSrc: GTE_LARGE_FP16 });

await ragIngest({ modelId, workspace, documents: samples, chunk: false });
console.log(`▸ Created workspace '${workspace}' with ${samples.length} document`);

await ragCloseWorkspace({ workspace, deleteOnClose: true });
console.log(`▸ Deleted workspace '${workspace}' and its on-disk files`);

await unloadModel({ modelId });
