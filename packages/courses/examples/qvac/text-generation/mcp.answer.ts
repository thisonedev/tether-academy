import { loadModel, completion, QWEN3_1_7B_INST_Q4 } from "@qvac/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const mcpClient = new Client({ name: "qvac-ddg-example", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "@oevortex/ddg_search"],
  });
  await mcpClient.connect(transport);

  const modelId = await loadModel({
    modelSrc: QWEN3_1_7B_INST_Q4,
    modelConfig: { ctx_size: 4096, tools: true },
  });

  const result = completion({
    modelId,
    history: [
      { role: "user", content: "What's the current weather in New York City?" },
    ],
    stream: true,
    mcp: [{ client: mcpClient, includeResources: false }],
  });

  for await (const event of result.events) {
    if (event.type === "toolCall") {
      console.log(`▸ Tool: ${event.call.name}(${JSON.stringify(event.call.arguments)})`);
    }
    if (event.type === "contentDelta") {
      process.stdout.write(event.text);
    }
  }

  await mcpClient.close();
}

main().catch(console.error);