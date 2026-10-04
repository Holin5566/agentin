import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createGateway } from '../gateway.js';
import { createToolCore } from '../core.js';
import { ToolFailure, type BuiltinTool } from '../types.js';
import { clientFor, registryOf, echo, ROUTES } from './helpers.js';

/**
 * Gateway 只做協議轉接,所以這裡只驗**形狀有沒有被改壞** —— 權限、三態、路由那些
 * 行為在 `core.test.ts`,不在這裡重測一遍。
 *
 * 但這幾支都跑**真的 MCP 往返**(caller ↔ gateway ↔ builtin server),因為轉接層的錯
 * 正是那種「單元測試都過、實際接起來壞掉」的錯。
 */
async function callerFor(tool: BuiltinTool, allow?: string[]) {
  const upstream = await clientFor([tool]);
  const core = createToolCore({
    clients: registryOf(upstream), routes: ROUTES, runId: 'test', log: () => {},
    ...(allow ? { allow } : {}),
  });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await createGateway({ core }).connect(s);
  const caller = new Client({ name: 'caller', version: '1' }, { capabilities: {} });
  await caller.connect(c);
  return caller;
}

describe('gateway — tools/list 的協議形狀', () => {
  it('核心的 id 變成協議的 name,schema 與 description 原樣帶過去', async () => {
    const { tools } = await (await callerFor(echo)).listTools();
    expect(tools.map((t: any) => t.name)).toEqual(['repo-search']);
    expect((tools[0] as any).inputSchema.required).toEqual(['query']);
    expect((tools[0] as any).description).toBe('test double');
  });

  it('上游的 toolName 不外洩', async () => {
    const { tools } = await (await callerFor(echo)).listTools();
    expect(JSON.stringify(tools)).not.toContain('repo_search');
  });

  it('allowlist 外的工具不出現在 tools/list', async () => {
    expect((await (await callerFor(echo, [])).listTools()).tools).toEqual([]);
  });
});

describe('gateway — tools/call 的協議形狀', () => {
  it.each([false, true])('保留完整上游結果，包括結構化資料與 metadata (isError=%s)', async (isError) => {
    const upstream = await clientFor([echo]);
    const result = {
      content: [
        { type: 'text' as const, text: 'screenshot captured' },
        { type: 'image' as const, data: 'aW1hZ2U=', mimeType: 'image/png' },
      ],
      structuredContent: { count: 1, files: ['screenshot.png'] },
      _meta: { traceId: 'upstream-trace' },
      isError,
    };
    const call = vi.spyOn(upstream, 'callTool').mockResolvedValue(result);
    const core = createToolCore({
      clients: registryOf(upstream), routes: ROUTES, runId: 'test', log: () => {},
    });
    const [c, s] = InMemoryTransport.createLinkedPair();
    const gateway = createGateway({ core });
    const caller = new Client({ name: 'caller', version: '1' }, { capabilities: {} });
    try {
      await gateway.connect(s);
      await caller.connect(c);
      expect(await caller.callTool({ name: 'repo-search', arguments: {} })).toEqual(result);
    } finally {
      call.mockRestore();
      await caller.close();
      await gateway.close();
      await upstream.close();
    }
  });

  it('成功:content 原樣,isError 為 false', async () => {
    const r: any = await (await callerFor(echo)).callTool({ name: 'repo-search', arguments: { query: 'abc' } });
    expect(r.content[0].text).toBe('echo:abc');
    expect(r.isError).toBeFalsy();
  });

  it('工具失敗:回 isError 讓模型看得到,不是丟協議錯誤', async () => {
    const caller = await callerFor({
      ...echo,
      async execute() { throw new ToolFailure('rag-service 不可用', 'url=…'); },
    });
    const r: any = await caller.callTool({ name: 'repo-search', arguments: { query: 'x' } });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('不可用');
  });

  it('content 是陣列原樣轉出,不是被壓成字串再包回去', async () => {
    // 核心刻意保留 content[] —— playwright 那類工具會回圖片,壓成文字就沒了。
    const r: any = await (await callerFor(echo)).callTool({ name: 'repo-search', arguments: { query: 'x' } });
    expect(Array.isArray(r.content)).toBe(true);
    expect(r.content[0].type).toBe('text');
  });

  it('清單外的工具 → 協議錯誤(MCP 沒有「不給你用」這種結果型別)', async () => {
    const caller = await callerFor(echo, []);
    await expect(caller.callTool({ name: 'repo-search', arguments: { query: 'x' } }))
      .rejects.toThrow(/not available/);
  });

  it('沒宣告過的名字一樣被拒', async () => {
    await expect((await callerFor(echo)).callTool({ name: 'rm-rf', arguments: {} }))
      .rejects.toThrow(/not available/);
  });

  it('取消:協議層也是 reject,不是回一個 isError 結果', async () => {
    const caller = await callerFor({
      ...echo,
      execute(_a, signal) {
        return new Promise((_res, rej) => {
          signal.addEventListener('abort', () => {
            const e: any = new Error('aborted'); e.name = 'AbortError'; rej(e);
          }, { once: true });
        });
      },
    });
    const ac = new AbortController();
    const p = caller.callTool({ name: 'repo-search', arguments: { query: 'x' } }, undefined, { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toThrow();
  });
});
