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

  // 1: search before the delete and log the count

  // 2: call ragDeleteEmbeddings and search after

  void ragDeleteEmbeddings;

  await ragCloseWorkspace({ workspace, deleteOnClose: true }).catch(() => {});
  await unloadModel({ modelId });
}

main().catch(console.error);