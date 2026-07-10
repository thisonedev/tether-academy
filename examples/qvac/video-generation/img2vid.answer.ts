import fs from "node:fs";
import { loadModel, WAN2_1_I2V_14B_Q4_K_M, UMT5_XXL_FP16, WAN_2_1_COMFYUI_REPACKAGED_VAE, CLIP_VISION_H, video, unloadModel } from "@qvac/sdk";

async function main() {
  const videoId = await loadModel({
    modelSrc: WAN2_1_I2V_14B_Q4_K_M,
    modelType: "sdcpp-generation",
    modelConfig: {
      mode: "video",
      t5XxlModelSrc: UMT5_XXL_FP16,
      vaeModelSrc: WAN_2_1_COMFYUI_REPACKAGED_VAE,
      clipVisionModelSrc: CLIP_VISION_H,
    },
  });

  const initImage = new Uint8Array(fs.readFileSync("./examples/diffusion/input/portrait.png"));

  const result = video({
    modelId: videoId,
    mode: "img2vid",
    prompt: "the subject slowly turns and smiles, soft natural lighting, cinematic",
    init_image: initImage,
    strength: 0.85,
    width: 480,
    height: 832,
    video_frames: 17,
    fps: 16,
  });

  const outputs = await result.outputs;
  const firstClip = outputs[0];
  if (!firstClip) throw new Error("No video returned from video()");
  fs.writeFileSync("portrait.mp4", firstClip);
  console.log(`Generated ${outputs.length} video`);

  await unloadModel({ modelId: videoId });
}

main().catch(console.error);
