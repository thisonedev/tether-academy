import { loadModel, SMOLVLM2_500M_MULTIMODAL_Q8_0, MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0, completion, unloadModel } from "@qvac/sdk";

async function main() {
  const multimodalId = await loadModel({
    modelSrc: SMOLVLM2_500M_MULTIMODAL_Q8_0,
    modelConfig: {
      projectionModelSrc: MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0,
    },
  });

  // 1: build a history with two image attachments

  // 2: call completion

  // 3: stream result.tokenStream to stdout

  await unloadModel({ modelId: multimodalId });
}

main().catch(console.error);