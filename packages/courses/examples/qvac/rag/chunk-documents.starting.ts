import { loadModel, GTE_LARGE_FP16, ragIngest } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({ modelSrc: GTE_LARGE_FP16 });

  const samples = [
    "PostgreSQL is an open-source relational database that extends SQL with advanced features like JSON, full-text search, and custom data types.",
    "Kubernetes is an open-source container orchestration platform that automates deployment, scaling, and management of containerized applications.",
    "React is a JavaScript library for building user interfaces, using a component-based architecture and a virtual DOM for efficient rendering.",
  ];

  const workspace = "tech";

  // 1: call ragIngest() with chunk: true and chunkOpts

  // 2: log the chunk count and document count

  await ragCloseWorkspace({ workspace, deleteOnClose: true }).catch(() => {});
  void ragIngest;
}

main().catch(console.error);