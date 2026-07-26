import { loadModel, SMOLVLM2_500M_MULTIMODAL_Q8_0, MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0 } from "@qvac/sdk";

async function main() {
  const multimodalId = await loadModel({
    modelSrc: SMOLVLM2_500M_MULTIMODAL_Q8_0,
    modelConfig: {
      projectionModelSrc: MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0,
    },
  });

  console.log("multimodalId:", multimodalId);
}

main().catch(console.error);
