import fs from "node:fs";
import {
  loadModel,
  REALESRGAN_X4PLUS_ANIME_6B,
  upscale,
  unloadModel,
} from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({
    modelSrc: REALESRGAN_X4PLUS_ANIME_6B,
    modelType: "diffusion",
    modelConfig: {
      mode: "upscale",
      upscaler: { tile_size: 128 },
    },
  });

  const pngBytes = new Uint8Array(
    fs.readFileSync("./examples/diffusion/input/sketch.png"),
  );

  const result = upscale({ modelId, image: pngBytes, repeats: 2 });
  const outputs = await result.outputs;
  const first = outputs[0];
  if (!first) throw new Error("No image returned from upscale");
  fs.writeFileSync("sketch_x16.png", first);
  console.log(`Generated ${outputs.length} image`);

  await unloadModel({ modelId });
}

main().catch(console.error);
