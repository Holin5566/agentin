import { expect, it, describe } from 'vitest';
import { createClientRegistry } from '../upstream/registry.js';
import { createToolCore } from '../core.js';
import type { BuiltinTool } from '../types.js';
import type { ServerDecl, ToolDecl } from '../manifest/load.js';

const echo: BuiltinTool = {
  name: 'echo',
  description: 'echo input',
  inputSchema: { type: 'object', properties: {} },
  execute: async (args) => String(args.message),
};

const HOST: ServerDecl = { id: 'host', transport: 'in-memory' };

describe('宿主注入的 builtin 工具', () => {
  it('掛得上 in-memory server,不需要套件內建任何整合', async () => {
    const registry = createClientRegistry([HOST], {}, [echo]);
    try {
      const client = await registry.get('host');
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['echo']);
      const result = await client.callTool({ name: 'echo', arguments: { message: 'ok' } });
      expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);
    } finally {
      await registry.closeAll();
    }
  });

  /**
   * 上面那條直接對 client 講話,繞過了路由 —— 它沒證明「注入之後 agent 真的叫得到」。
   * 這條走 core:對外用 manifest 的 tool id,core 才翻成上游的 `echo`。
   * 注入的只是**實作**,工具仍然要經過宣告才存在。
   */
  it('仍然要 manifest 宣告一條 route,對外露出的是 tool id 不是實作名', async () => {
    const routes: ToolDecl[] = [{ id: 'host-echo', serverId: 'host', toolName: 'echo' }];
    const registry = createClientRegistry([HOST], {}, [echo]);
    try {
      const core = createToolCore({
        routes, allow: ['host-echo'], clients: registry, runId: 'test', log: () => {},
      });
      expect((await core.list()).map((t) => t.id)).toEqual(['host-echo']);
      const result = await core.call('host-echo', { message: 'routed' });
      expect(result.content).toEqual([{ type: 'text', text: 'routed' }]);
      expect(result.isError).toBe(false);
    } finally {
      await registry.closeAll();
    }
  });

  it('宣告兩台 in-memory server 時拒絕注入 —— 沒有答案的事不要靜默給一個', () => {
    expect(() => createClientRegistry(
      [HOST, { id: 'host2', transport: 'in-memory' }],
      {},
      [echo],
    )).toThrow(/只能宣告一台 in-memory server.*host, host2/s);
  });

  it('沒有要注入工具時,多台 in-memory 不擋 —— 這個限制只為了消除歧義', () => {
    expect(() => createClientRegistry(
      [HOST, { id: 'host2', transport: 'in-memory' }],
      {},
    )).not.toThrow();
  });
});
