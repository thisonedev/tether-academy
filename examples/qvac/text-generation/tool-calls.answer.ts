import { loadModel, completion, QWEN3_1_7B_INST_Q4 } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({
    modelSrc: QWEN3_1_7B_INST_Q4,
    modelConfig: { ctx_size: 4096, tools: true },
  });

  const tools = [
    {
      name: "get_weather",
      description: "Get current weather for a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  ];

  const result = completion({
    modelId,
    history: [{ role: "user", content: "What's the weather in Tokyo?" }],
    tools,
    stream: true,
  });

  for await (const event of result.events) {
    if (event.type === "toolCall") {
      console.log(`▸ Tool: ${event.call.name}(${JSON.stringify(event.call.arguments)})`);
    }
  }
}

main().catch(console.error);