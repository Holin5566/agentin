import { defineAgent } from '../agents/manifest.js';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createMemoryStore } from '../artifacts/memory.js';
import { createAgentEngine } from '../engine.js';

// 另開一個檔:vi.mock 會套到整個檔案。這裡只記下 engine 交給 gateway 的參數。
const acquired = vi.hoisted(() => [] as Array<{ env?: Record<string, string | undefined> }>);
vi.mock('../run/gateway.js', async (orig) => ({
  ...(await orig<typeof import('../run/gateway.js')>()),
  createGatewayPool: () => ({
    acquire: (o: { env?: Record<string, string | undefined> }) => { acquired.push(o); return { configPath: undefined, close: () => {} }; },
    closeAll: () => {},
    size: 0,
  }),
}));

it('take 層 env 疊在 engine 層之上,並行 take 各帶各的,互不覆蓋', async () => {
  const engine = createAgentEngine({
    root: join(__dirname, 'fixture'),
    runtime: {
      name: 'script',
      capabilities: { skills: true, nativeTools: true, filesystemPolicy: 'tool-list', maxSteps: false },
      command: () => ({ file: process.execPath, args: ['-e', ''] }),
    },
    env: { SHARED: 'engine', OVERRIDE: 'engine' },
    log: () => {},
    artifacts: createMemoryStore(),
  });
  await Promise.all([
    engine.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'x', env: { OVERRIDE: 'take-a', ONLY_A: '1' } }),
    engine.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'x', env: { OVERRIDE: 'take-b' } }),
    engine.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'x' }),
  ]);
  await engine.close();

  expect(acquired.map((o) => o.env)).toEqual([
    { SHARED: 'engine', OVERRIDE: 'take-a', ONLY_A: '1' },
    { SHARED: 'engine', OVERRIDE: 'take-b' },
    { SHARED: 'engine', OVERRIDE: 'engine' },
  ]);
});
