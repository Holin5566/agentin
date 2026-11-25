import { expect, it } from 'vitest';
import {
  createAgentin, createMemoryStore, createOntology, createOntologyTool, defineAgent, vercelAiRuntime,
  type OntologyDefinition,
} from '../../src/index.js';
import { startFakeOpenAi } from '../../agent-engine/src/__tests__/helpers/fakeOpenAi.js';

const fixture: OntologyDefinition = require('../../examples/ontology-graph.json');
const query = { route: 'group-payment', source: { label: 'Alpha' } };

it('validates tool inputs and returns structured routing results', async () => {
  const tool = createOntologyTool(createOntology(fixture));
  const context = { signal: new AbortController().signal, agent: 'service-assistant', runId: 'test' };
  await expect(tool.execute(query, context)).resolves.toMatchObject({
    structuredContent: { status: 'resolved', selection: 'default', targetId: 'payment-service-a' },
  });
  for (const source of [{}, { label: ' ' }, { label: 'Alpha', entityId: 'shop-b' }]) {
    await expect(tool.execute({ ...query, source }, context)).rejects.toThrow(/Invalid tool arguments/);
  }
  await expect(tool.execute(query, { ...context, signal: AbortSignal.abort() })).rejects.toThrow();
});

it('returns clarification through the scoped MCP path only for the registered agent', async () => {
  const graph = structuredClone(fixture);
  delete graph.edges[1].default;
  const tool = createOntologyTool(createOntology(graph));
  const model = await startFakeOpenAi(n => n === 0
    ? { kind: 'call', name: tool.id, args: JSON.stringify(query) }
    : { kind: 'text', text: 'Choose a payment service.' });
  const app = createAgentin({
    agents: [
      defineAgent({ id: 'service-assistant', instructions: '', tools: [tool] }),
      defineAgent({ id: 'general-assistant', instructions: '' }),
    ],
    runtimes: { ai: vercelAiRuntime({ baseUrl: model.url, model: 'test' }) },
    defaultRuntime: 'ai',
    artifacts: createMemoryStore(),
  });
  try {
    const result = await app.run({ agent: 'service-assistant', input: 'Check Alpha payment status', timeoutMs: 4000 });
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ status: 'ok', output: 'Choose a payment service.', cleanup: 'complete' });
    expect(model.requests[0].body.tools.map((entry: { function: { name: string } }) => entry.function.name)).toEqual([tool.id]);
    const messages = JSON.stringify(model.requests[1].body.messages);
    expect(messages).toContain('clarification');
    expect(messages).toContain('payment-service-a');
    expect(messages).toContain('payment-service-b');
    expect((await app.run({ agent: 'general-assistant', input: 'Hello', timeoutMs: 4000 })).status).toBe('ok');
    expect(model.requests[2].body.tools ?? []).toEqual([]);
  } finally {
    await app.close();
    await model.close();
  }
});
