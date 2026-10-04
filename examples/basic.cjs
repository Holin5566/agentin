const { createAgentin, defineAgent, claudeRuntime, createMemoryStore } = require('../dist');

async function main() {
  // Pass --claude explicitly to use the locally installed and authenticated CLI.
  const real = process.argv.includes('--claude');
  const local = {
    name: 'local-echo',
    capabilities: { skills: false, nativeTools: false, filesystemPolicy: 'tool-list', maxSteps: false },
    command: ({ prompt }) => ({ file: process.execPath, args: ['-e', 'process.stdin.pipe(process.stdout)'], stdin: prompt }),
  };
  const app = createAgentin({
    agents: [defineAgent({ id: 'assistant', instructions: '用繁體中文簡短回答。', tools: [] })],
    runtimes: { local, claude: claudeRuntime() },
    defaultRuntime: real ? 'claude' : 'local',
    artifacts: createMemoryStore(),
  });
  try {
    const result = await app.run({ agent: 'assistant', input: '解釋 SDK 的用途', timeoutMs: 30000, onEvent: event => {
      if (event.type === 'completed') console.log(`status=${event.status}`);
    } });
    console.log(result.output);
    if (result.status !== 'ok') process.exitCode = 1;
  } finally { await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
