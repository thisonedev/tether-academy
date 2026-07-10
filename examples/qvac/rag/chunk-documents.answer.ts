import { loadModel, GTE_LARGE_FP16, ragIngest } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({ modelSrc: GTE_LARGE_FP16 });

  const samples = [
    "PostgreSQL is an open-source relational database that extends SQL with advanced features. It supports JSON, full-text search, and custom data types, making it suitable for both transactional and analytical workloads. Performance tuning involves indexing, query optimization, and connection pooling.",
    "Kubernetes is an open-source container orchestration platform that automates the deployment, scaling, and management of containerized applications. It groups containers into pods and provides service discovery, load balancing, and self-healing capabilities. Cluster management relies on etcd for state and kubelet for node communication.",
    "React is a JavaScript library for building user interfaces, originally developed by Facebook. It uses a component-based architecture and a virtual DOM to efficiently update the browser when state changes. Hooks like useState and useEffect manage state and side effects in functional components.",
  ];

  const workspace = "tech";

  const result = await ragIngest({
    modelId,
    workspace,
    documents: samples,
    chunk: true,
    chunkOpts: { chunkSize: 50, chunkOverlap: 10 },
  });

  console.log(`Created ${result.processed.length} chunks from ${samples.length} documents`);
}

main().catch(console.error);