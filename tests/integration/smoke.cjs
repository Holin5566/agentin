const assert = require('node:assert/strict');
const { openGateway } = require('../../mcp-hub/dist');
const { createAgentEngine, createMemoryStore, defineAgent } = require('../../agent-engine/dist');

async function main() {
  const hub = await openGateway({
    tools: ['echo'], log: () => {},
    catalog: { servers: [{ id: 'host', transport: 'in-memory' }], tools: [{ id: 'echo', serverId: 'host', toolName: 'echo' }] },
    builtinTools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] }, execute: async ({ message }) => message }],
  });
  const agent = defineAgent({ id: 'smoke', tools: [], capabilities: { filesystem: 'none', shell: false } });
  const events = [];
  const engine = createAgentEngine({
    agents: [agent], artifacts: createMemoryStore(),
    runtime: {
      name: 'local-smoke', capabilities: { skills: false, nativeTools: false, filesystemPolicy: 'tool-list', maxSteps: false },
      command: ({ prompt }) => ({ file: process.execPath, args: ['-e', "process.stdin.setEncoding('utf8');let text='';process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>process.stdout.write(text));"], stdin: prompt }),
    },
    onEvent: event => events.push(event),
  });
  try {
    const tool = await hub.callResult('echo', { message: 'agentin smoke' });
    const result = await engine.runTake({ agent, prompt: tool.content[0].text, timeoutMs: 3000 });
    assert.equal(result.status, 'ok');
    assert.equal(result.output, 'agentin smoke');
    assert.equal(result.cleanup, 'complete');
    assert.ok(result.artifact);
    assert.equal(events.filter(e => e.type === 'completed').length, 1);
    console.log('Engine + Hub smoke passed');
  } finally {
    await engine.close();
    await hub.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
