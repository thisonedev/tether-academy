import { startQVACProvider } from "@qvac/sdk";

const seed = process.argv[2];
const allowedConsumerPublicKey = process.argv[3];

if (seed) {
  process.env.QVAC_HYPERSWARM_SEED = seed;
}

console.log(`▸ Starting provider service...`);

try {
  if (allowedConsumerPublicKey) {
    console.log(
      `▸ Firewall enabled: only allowing consumer ${allowedConsumerPublicKey}`,
    );
  }

  const response = await startQVACProvider({
    firewall: allowedConsumerPublicKey
      ? {
          mode: "allow" as const,
          publicKeys: [allowedConsumerPublicKey],
        }
      : undefined,
  });

  console.log("▸ Provider service started successfully.");
  console.log(`▸ Provider Public Key: ${response.publicKey}`);
  console.log("");
  console.log(`▸ Consumer command:`);
  console.log(`   node consumer.ts ${response.publicKey}`);
} catch (error) {
  console.error("✖", error);
  process.exit(1);
}
