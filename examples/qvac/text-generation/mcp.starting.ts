import { loadModel, completion, QWEN3_1_7B_INST_Q4 } from "@qvac/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const mcpClient = new Client({ name: "my-app", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "@oevortex/ddg_search"],
  });
  await mcpClient.connect(transport);

  const modelId = await loadModel({ modelSrc: QWEN3_1_7B_INST_Q4 });

  // 1: call completion() with mcp: [{ client, includeResources: false }]

  // 2: iterate result.events logging toolCall and contentDelta events

  await mcpClient.close();
}

main().catch(console.error);