import fs from "node:fs";
import path from "path";
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
      upscaler: {
        type: "esrgan",
        model_src: REALESRGAN_X4PLUS_ANIME_6B,
        tile_size: 128,
      },
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

  const x4 = diffusion({ ...baseParams, upscale: true });
  const x4Buffers = await x4.outputs;
  fs.writeFileSync("fox_x4.png", x4Buffers[0]!);

  const x16 = diffusion({ ...baseParams, upscale: { repeats: 2 } });
  const x16Buffers = await x16.outputs;
  fs.writeFileSync("fox_x16.png", x16Buffers[0]!);

  console.log("Generated 1 image");
  await unloadModel({ modelId });
}

main().catch(console.error);
