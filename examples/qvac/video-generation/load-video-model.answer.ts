import { loadModel, WAN2_1_T2V_1_3B_FP16, UMT5_XXL_FP16, WAN_2_1_COMFYUI_REPACKAGED_VAE } from "@qvac/sdk";

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

  console.log("videoId:", videoId);
}

main().catch(console.error);
