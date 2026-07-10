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
      content: "Compare the two newspaper articles. Which one is older?",
      attachments: [
        { path: "./examples/multimodal/input/article-a.jpg" },
        { path: "./examples/multimodal/input/article-b.jpg" },
      ],
    },
  ];

  const result = completion({ modelId: multimodalId, history, stream: true });
  for await (const token of result.tokenStream) {
    process.stdout.write(token);
  }
  process.stdout.write("\n");

  await unloadModel({ modelId: multimodalId });
}

main().catch(console.error);
