import { defineAgent } from '../agents/manifest.js';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createMemoryStore } from '../artifacts/memory.js';
import { createAgentEngine } from '../engine.js';
import type { RunEvent } from '../types.js';

// 另開一個檔:vi.mock 會套到整個檔案(並提升到 import 之前),放進 engine.test.ts 會讓其他 take
// 也開不了 gateway。
vi.mock('../run/gateway.js', async (orig) => ({
  ...(await orig<typeof import('../run/gateway.js')>()),
  createGatewayPool: () => ({
    acquire: () => { throw new Error('mkdtemp 失敗'); },
    closeAll: () => {},
    size: 0,
  }),
}));

it('gateway 開不起來時,take 回傳 error 且照樣發出 completed —— started 之後一定有 completed', async () => {
  const events: RunEvent[] = [];
  const engine = createAgentEngine({
    root: join(__dirname, 'fixture'),
    runtime: {
      name: 'script',
      capabilities: { skills: true, nativeTools: true, filesystemPolicy: 'tool-list', maxSteps: false },
      command: () => ({ file: process.execPath, args: ['-e', ''] }),
    },
    onEvent: (e) => events.push(e),
    log: () => {},
    artifacts: createMemoryStore(),
  });
  const result = await engine.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'x' });
  await engine.close();

  expect(result.status).toBe('error');
  expect(result.error?.message).toContain('mkdtemp 失敗');
  expect(events.map(e => e.type)).toEqual(['started', 'completed']);
});
