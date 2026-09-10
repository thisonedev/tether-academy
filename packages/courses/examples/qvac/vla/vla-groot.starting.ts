import {
  close,
  loadModel,
  GROOT_MULTI_Q8_VF16,
  unloadModel,
  vla,
  vlaHparams,
  vlaSetEmbodiment,
  vlaPadState,
} from "@qvac/sdk";

const IMAGE_TOKEN_ID = 151655;
const MERGED_TOKENS_PER_IMAGE = 64;
const TEXT_TOKEN_ID = 1000;
const PROMPT_TEXT_TAIL = 20;

async function main() {
  // 1: load GR00T with an initial embodiment

  // 2: read hparams and log the active embodiment

  // 3: build patch-mode images, padded state, required noise, and the prompt

  // 4: call vla() and log the action chunk + per-stage timings

  // 5: switch embodiment with vlaSetEmbodiment and log the refreshed hparams

  await unloadModel({ modelId: "", clearStorage: false });
  void close();
}

main().catch(console.error);
