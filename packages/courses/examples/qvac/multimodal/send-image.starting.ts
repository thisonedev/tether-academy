import { loadModel, SMOLVLM2_500M_MULTIMODAL_Q8_0, MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0, completion, unloadModel } from "@qvac/sdk";

async function main() {
  const multimodalId = await loadModel({
    modelSrc: SMOLVLM2_500M_MULTIMODAL_Q8_0,
    modelConfig: {
      projectionModelSrc: MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0,
    },
  });

  const history = [
    {
      role: "user",
      content: "What's in this image?",
      // 1: add `attachments: [{ path: <image-file> }]` here
    },
  ];

  // 2: call completion

  // 3: iterate result.tokenStream and write each token to stdout

  await unloadModel({ modelId: multimodalId });
}

main().catch(console.error);