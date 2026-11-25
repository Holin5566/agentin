const { createAgentin, defineAgent, defineTool, vercelAiRuntime, createMemoryStore } = require('../dist');
const { z } = require('zod/v4');

async function main() {
  if (!process.env.AGENTIN_MODEL) throw new Error('Set AGENTIN_MODEL and AGENTIN_BASE_URL before running');
  const greeting = '你好'; // Captured by host code; never serialized to the child.
  const greet = defineTool({
    id: 'greet', description: 'Greet someone in Chinese',
    inputSchema: z.strictObject({ name: z.string().min(1).describe('要打招呼的對象姓名') }),
    execute: async ({ name }, { signal }) => {
      signal.throwIfAborted();
      return `${greeting}，${name}！`;
    },
  });
  const app = createAgentin({
    agents: [defineAgent({ id: 'assistant', instructions: '使用 greet 工具向使用者打招呼。', tools: [greet] })],
    runtimes: { ai: vercelAiRuntime({ baseUrl: process.env.AGENTIN_BASE_URL, model: process.env.AGENTIN_MODEL, apiKey: process.env.AGENTIN_API_KEY }) },
    defaultRuntime: 'ai', artifacts: createMemoryStore(),
  });
  try {
    const result = await app.run({ agent: 'assistant', input: '我的名字是小明。', timeoutMs: 30000 });
    console.log(result.status, result.output);
    if (result.status !== 'ok') { console.error(result.error ?? result.stopReason); process.exitCode = 1; }
  } finally { await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
