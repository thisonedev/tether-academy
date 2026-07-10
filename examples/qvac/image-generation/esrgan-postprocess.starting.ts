import {
  loadModel,
  SD_V2_1_1B_Q8_0,
  REALESRGAN_X4PLUS_ANIME_6B,
  diffusion,
  unloadModel,
} from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({
    modelSrc: SD_V2_1_1B_Q8_0,
    modelType: "sdcpp-generation",
    modelConfig: {
      prediction: "v",
      // 1: add the upscaler block
    },
  });

  const baseParams = {
    modelId,
    prompt: "a red fox portrait, soft watercolor background",
    width: 128,
    height: 128,
    steps: 5,
    seed: 42,
  };

  // 2: call diffusion with upscale: true

  fs.writeFileSync("fox_x4.png", x4Buffers[0]!);

  // 3: call diffusion with upscale: { repeats: 2 }

  fs.writeFileSync("fox_x16.png", x16Buffers[0]!);

  console.log("Generated 1 image");
  await unloadModel({ modelId });
}

main().catch(console.error);