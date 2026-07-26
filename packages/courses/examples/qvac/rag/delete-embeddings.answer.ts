import {
  loadModel,
  unloadModel,
  GTE_LARGE_FP16,
  ragIngest,
  ragSearch,
  ragDeleteEmbeddings,
  ragCloseWorkspace,
} from "@qvac/sdk";

async function main() {
  const workspace = "delete-embeddings-demo";
  const samples = [
    "Machine learning is a subset of artificial intelligence that focuses on algorithms.",
    "Deep learning uses neural networks with multiple layers for complex patterns.",
    "Natural language processing combines computational linguistics with machine learning.",
  ];

  const modelId = await loadModel({ modelSrc: GTE_LARGE_FP16 });

  const ingest = await ragIngest({
    modelId,
    workspace,
    documents: samples,
    chunk: false,
  });
  const ids = ingest.processed
    .filter((p) => p.status === "fulfilled" && p.id)
    .map((p) => p.id!) as string[];

  const before = await ragSearch({ modelId, workspace, query: "neural networks", topK: 5 });
  console.log(`▸ Before delete: ${before.length} matches`);

  if (ids.length > 0) {
    await ragDeleteEmbeddings({ workspace, ids: [ids[0]!] });
    console.log(`▸ Deleted embedding ${ids[0]}`);
  }

  const after = await ragSearch({ modelId, workspace, query: "neural networks", topK: 5 });
  console.log(`▸ After delete: ${after.length} matches`);

  await ragCloseWorkspace({ workspace, deleteOnClose: true });
  await unloadModel({ modelId });
}

main().catch(console.error);
