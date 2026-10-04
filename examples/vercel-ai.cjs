const { createAgentin, defineAgent, vercelAiRuntime, createMemoryStore } = require('../dist');

async function main() {
  const model = process.env.AGENTIN_MODEL;
  if (!model) throw new Error('Set AGENTIN_MODEL before running this example');
  const app = createAgentin({
    agents: [defineAgent({ id: 'assistant', instructions: '用繁體中文簡短回答。' })],
    runtimes: {
      ai: vercelAiRuntime({
        provider: process.env.AGENTIN_PROVIDER ?? 'openai-compat',
        baseUrl: process.env.AGENTIN_BASE_URL,
        apiKey: process.env.AGENTIN_API_KEY,
        model,
      }),
    },
    defaultRuntime: 'ai', artifacts: createMemoryStore(),
  });
  try {
    const result = await app.run({ agent: 'assistant', input: '解釋 SDK 的用途', timeoutMs: 30000 });
    console.log(result.status, result.output);
    if (result.status !== 'ok') { console.error(result.error ?? result.stopReason); process.exitCode = 1; }
  } finally { await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
