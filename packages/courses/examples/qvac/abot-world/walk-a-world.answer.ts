import fs from "node:fs";
import {
  loadModel,
  unloadModel,
  worldCreateScene,
  worldStep,
  ABOT_WORLD_0_5B_Q8_0,
  ABOT_WORLD_0_5B_LF_VAE,
  ABOT_WORLD_0_5B_LF_VAE_F16,
  UMT5_XXL_ENC_Q8_0,
} from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({
    modelSrc: ABOT_WORLD_0_5B_Q8_0,
    modelType: "sdcpp-generation",
    modelConfig: {
      mode: "world",
      taehvModelSrc: ABOT_WORLD_0_5B_LF_VAE,
      t5XxlModelSrc: UMT5_XXL_ENC_Q8_0,
      vaeModelSrc: ABOT_WORLD_0_5B_LF_VAE_F16,
      world: { seed: 42, kvCache: true },
    },
  });

  const firstFrame = new Uint8Array(fs.readFileSync("./examples/qvac/abot-world/input/first-frame.png"));
  const creation = worldCreateScene({
    modelId,
    prompt: "A realistic outdoor world scene with a navigable path.",
    image: firstFrame,
    width: 832,
    height: 480,
  });
  await creation.stats;
  console.log("Scene created");

  const tape: string[][] = [["W"], ["W", "L"], ["W"], []];
  let frameNumber = 0;
  for (const keys of tape) {
    const { frameStream } = worldStep({ modelId, keys });
    for await (const frame of frameStream) {
      fs.writeFileSync(`output/abot-world/frame-${String(frameNumber++).padStart(4, "0")}.jpg`, frame);
    }
  }
  console.log(`Walked ${tape.length} blocks`);

  await unloadModel({ modelId });
}

main().catch(console.error);
