export const AI_BOT_MODEL_NAMES = [
  'Qwen3-0.6B-Q4_0.gguf',
  'Qwen3-1.7B-Q4_0.gguf',
  'Qwen3-4B-Q4_K_M.gguf',
  'Qwen3-8B-Q4_K_M.gguf',
] as const;

const AI_BOT_MODEL_SET: ReadonlySet<string> = new Set(AI_BOT_MODEL_NAMES);

export function isAiBotModel(name: string): boolean {
  return AI_BOT_MODEL_SET.has(name);
}
