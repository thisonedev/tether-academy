import fs from "node:fs";
import { loadModel, WAN2_1_T2V_1_3B_FP16, UMT5_XXL_FP16, WAN_2_1_COMFYUI_REPACKAGED_VAE, video, unloadModel } from "@qvac/sdk";

async function main() {
  const videoId = await loadModel({
    modelSrc: WAN2_1_T2V_1_3B_FP16,
    modelType: "sdcpp-generation",
    modelConfig: {
      mode: "video",
      t5XxlModelSrc: UMT5_XXL_FP16,
      vaeModelSrc: WAN_2_1_COMFYUI_REPACKAGED_VAE,
    },
  });

  const result = video({
    modelId: videoId,
    mode: "txt2vid",
    prompt: "a colorful bird flapping its wings",
    width: 480,
    height: 832,
    video_frames: 17,
    fps: 16,
  });

  const outputs = await result.outputs;
  const firstClip = outputs[0];
  if (!firstClip) throw new Error("No video returned from video()");
  fs.writeFileSync("bird.avi", firstClip);
  console.log(`Generated ${outputs.length} video`);

  await unloadModel({ modelId: videoId });
}

main().catch(console.error);
