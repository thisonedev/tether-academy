import {
  loadModel,
  unloadModel,
  embed,
  GTE_LARGE_FP16,
  ragChunk,
  ragSaveEmbeddings,
  ragCloseWorkspace,
  type RagEmbeddedDoc,
} from "@qvac/sdk";

async function main() {
  const samples = [
    "Machine learning is a subset of artificial intelligence that focuses on algorithms that can learn from data.",
    "Deep learning uses neural networks with multiple layers to process complex data patterns.",
    "Natural language processing combines computational linguistics with machine learning.",
  ];

  const modelId = await loadModel({ modelSrc: GTE_LARGE_FP16 });

  const chunks = await ragChunk({
    documents: samples,
    chunkOpts: { chunkSize: 128, chunkOverlap: 20 },
  });

  const texts = chunks.map((c) => c.content);
  const { embedding: embeddings } = await embed({ modelId, text: texts });

  const embeddedDocs = chunks.map((chunk, i) => ({
    id: chunk.id,
    content: chunk.content,
    embedding: embeddings[i]!,
    embeddingModelId: modelId,
  })) as RagEmbeddedDoc[];

  // 1: call ragSaveEmbeddings() and log the count of fulfilled saves
}

  void ragSaveEmbeddings;

  await ragCloseWorkspace({ workspace: "save-embeddings-demo", deleteOnClose: true }).catch(
    () => {},
  );
  await unloadModel({ modelId });
}

main().catch(console.error);