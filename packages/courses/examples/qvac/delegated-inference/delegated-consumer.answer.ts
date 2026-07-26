import {
  completion,
  LLAMA_3_2_1B_INST_Q4_0,
  loadModel,
  close,
} from "@qvac/sdk";

const providerPublicKey = process.argv[2];
if (!providerPublicKey) {
  console.error("✖ Provider public key required.");
  process.exit(1);
}

try {
  console.log(`▸ Testing delegated inference`);
  console.log(`▸ Provider: ${providerPublicKey}`);

  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    delegate: {
      providerPublicKey,
      timeout: 60_000,
      fallbackToLocal: true,
    },
  });

  console.log(`▸ Delegated model registered: ${modelId}`);

  const response = completion({
    modelId,
    history: [{ role: "user", content: "Hello!" }],
    stream: true,
  });

  for await (const token of response.tokenStream) {
    process.stdout.write(token);
  }

  console.log("\n▸ Stats:", await response.stats);
  void close();
} catch (error) {
  console.error("✖", error);
  process.exit(1);
}
