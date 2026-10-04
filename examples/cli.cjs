const { createAgentin, defineAgent, claudeRuntime, opencodeRuntime, createMemoryStore } = require('../dist');

async function main() {
  const name = process.argv[2];
  if (!['claude', 'opencode'].includes(name)) throw new Error('Usage: node examples/cli.cjs claude|opencode');
  const app = createAgentin({
    agents: [defineAgent({ id: 'assistant', instructions: '用繁體中文簡短回答。' })],
    runtimes: { claude: claudeRuntime(), opencode: opencodeRuntime() },
    defaultRuntime: name, artifacts: createMemoryStore(),
  });
  try {
    const result = await app.run({ agent: 'assistant', input: '解釋 SDK 的用途', model: process.env.AGENTIN_MODEL, timeoutMs: 30000 });
    console.log(result.status, result.output);
    if (result.status !== 'ok') { console.error(result.error ?? result.stopReason); process.exitCode = 1; }
  } finally { await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
