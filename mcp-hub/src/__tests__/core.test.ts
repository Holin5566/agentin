import { describe, it, expect, vi } from 'vitest';
import { createToolCore, isAuthFailure, ToolDenied } from '../core.js';
import { OAuthLoginRequired } from '../upstream/oauth.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { ToolFailure, type BuiltinTool } from '../types.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDecl } from '../manifest/load.js';
import { clientFor, registryOf, echo, ROUTES } from './helpers.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/**
 * 權限、路由、三態、取消 —— 全部在核心,兩個入口共用這一份。
 * gateway 那邊只驗「協議形狀沒被改壞」,見 gateway.test.ts。
 */
async function coreWith(tool: BuiltinTool, allow?: string[], routes: ToolDecl[] = ROUTES) {
  const upstream = await clientFor([tool]);
  return createToolCore({
    clients: registryOf(upstream), routes, runId: 'test', log: () => {},
    ...(allow ? { allow } : {}),
  });
}

describe('core — 名稱與允許清單', () => {
  it('對外只露 guardian tool id,不露上游的 toolName', async () => {
    const listed = await (await coreWith(echo)).list();
    expect(listed.map((t) => t.id)).toEqual(['repo-search']);
    expect(JSON.stringify(listed)).not.toContain('repo_search');
  });

  it('schema 從上游取,不在核心重寫一份', async () => {
    const listed = await (await coreWith(echo)).list();
    expect((listed[0].inputSchema as any).required).toEqual(['query']);
  });

  it('allowlist 外的工具不出現在 list', async () => {
    expect(await (await coreWith(echo, [])).list()).toEqual([]);
  });

  it('allowlist 外的工具即使直接呼叫也被拒,不會轉發到上游', async () => {
    const spy = vi.fn(async () => 'should not run');
    const core = await coreWith({ ...echo, execute: spy }, []);
    await expect(core.call('repo-search', { query: 'x' })).rejects.toBeInstanceOf(ToolDenied);
    expect(spy).not.toHaveBeenCalled();
  });

  it('沒宣告過的名字一樣被拒', async () => {
    await expect((await coreWith(echo)).call('rm-rf', {})).rejects.toBeInstanceOf(ToolDenied);
  });

  it('ToolDenied 帶著「可用的是這些」,讓上層組得出有用的訊息', async () => {
    const core = await coreWith(echo);
    const err = await core.call('rm-rf', {}).catch((e) => e);
    expect(err.allow).toEqual(['repo-search']);
  });
});

describe('core — 三態契約', () => {
  it('連線失敗也記錄 runId、工具與失敗狀態', async () => {
    const log = vi.fn();
    const failure = new Error('connection refused');
    const core = createToolCore({
      clients: { get: vi.fn().mockRejectedValue(failure), drop() {}, async closeAll() {} },
      routes: ROUTES, runId: 'connect-failure', log,
    });
    await expect(core.call('repo-search')).rejects.toBe(failure);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(
      /\[gateway connect-failure\] tools\/call repo-search → FAILED \d+ms/,
    ));
  });

  it('成功:文字內容原樣回來', async () => {
    const r = await (await coreWith(echo)).call('repo-search', { query: 'abc' });
    expect(r.isError).toBe(false);
    expect((r.content[0] as any).text).toBe('echo:abc');
  });

  it('服務失敗:isError = true,訊息看得到', async () => {
    const core = await coreWith({
      ...echo,
      async execute() { throw new ToolFailure('rag-service 不可用', 'url=…'); },
    });
    const r = await core.call('repo-search', { query: 'x' });
    expect(r.isError).toBe(true);
    expect((r.content[0] as any).text).toContain('不可用');
  });

  it('服務失敗 ≠ 查無資料 —— 空結果是成功', async () => {
    const core = await coreWith({ ...echo, async execute() { return 'No matches.'; } });
    expect((await core.call('repo-search', { query: 'x' })).isError).toBe(false);
  });

  it('取消:往上丟,不會被當成工具失敗', async () => {
    const core = await coreWith({
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
    const p = core.call('repo-search', { query: 'x' }, ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow();
  });
});

describe('core — 路由宣告', () => {
  it('宣告的工具上游不存在時 fail loud,不靜默少一個', async () => {
    const core = await coreWith({ ...echo, name: 'something_else' });
    await expect(core.list()).rejects.toThrow(/has no tool repo_search/);
  });

  it('manifest 的 description 覆蓋上游的', async () => {
    const core = await coreWith(echo, undefined, [
      { ...ROUTES[0], description: 'guardian 語境下的說明' },
    ]);
    expect((await core.list())[0].description).toBe('guardian 語境下的說明');
  });

  it('manifest 沒寫 description 就用上游的', async () => {
    expect((await (await coreWith(echo)).list())[0].description).toBe('test double');
  });
});

describe('core — 逾時', () => {
  /** 攔在 client 這一層,看 core 到底把什麼選項送下去。 */
  const optsOf = async (route: Partial<ToolDecl>, signal?: AbortSignal) => {
    const upstream = await clientFor([echo]);
    const spy = vi.spyOn(upstream, 'callTool').mockResolvedValue({ content: [] } as any);
    const core = createToolCore({
      clients: registryOf(upstream),
      routes: [{ ...ROUTES[0], ...route }],
      runId: 't',
      log: () => {},
    });
    await core.call('repo-search', { query: 'x' }, signal);
    return spy.mock.calls[0][2] as Record<string, unknown>;
  };

  it('resetTimeoutOnProgress 一律開 —— 慢但正常的動作不該被當成掛掉', async () => {
    // 沒開的話,會回報進度的長動作(慢站導航、影片 finalize)會被 SDK 預設的
    // 60 秒砍掉,而錯誤長得跟「連不上」一模一樣,分不出來。
    expect(await optsOf({})).toMatchObject({ resetTimeoutOnProgress: true });
  });

  it('一定要給 onprogress,否則 resetTimeoutOnProgress 是死的', async () => {
    // 沒給的話 SDK 不會送出 progressToken,上游根本不知道要回報進度。
    expect(typeof (await optsOf({})).onprogress).toBe('function');
  });

  it('maxTotalTimeout 傳得到 —— 進度可以無限延長逾時,這是硬上限', async () => {
    expect(await optsOf({ maxTotalTimeoutMs: 600_000 })).toMatchObject({ maxTotalTimeout: 600_000 });
  });

  it('manifest 的 timeoutMs 傳得到上游', async () => {
    expect(await optsOf({ timeoutMs: 120_000 })).toMatchObject({ timeout: 120_000 });
  });

  it('沒宣告就不傳 timeout,吃 SDK 預設 —— 不在 code 裡塞自己的預設值', async () => {
    // 塞了的話,每台上游的實際逾時會變成要讀 code 才知道,而它該寫在 manifest 上。
    expect(await optsOf({})).not.toHaveProperty('timeout');
  });

  it('取消訊號仍然傳得下去', async () => {
    const signal = new AbortController().signal;
    expect(await optsOf({ timeoutMs: 5000 }, signal)).toMatchObject({ signal, timeout: 5000 });
  });
});

describe('core — 呼叫失敗時丟棄連線', () => {
  /** 讓 callTool 丟指定的錯,回報 core 有沒有 drop。 */
  const callFailing = async (err: unknown, signal?: AbortSignal) => {
    const upstream = await clientFor([echo]);
    vi.spyOn(upstream, 'callTool').mockRejectedValue(err);
    const dropped: Array<{ serverId: string; client: unknown }> = [];
    const core = createToolCore({
      clients: registryOf(upstream, dropped as any), routes: ROUTES, runId: 't', log: () => {},
    });
    await core.call('repo-search', { query: 'x' }, signal).catch(() => {});
    return { dropped, upstream };
  };

  it('HTTP session 失效(404)→ 丟棄連線,下次重連', async () => {
    // session 失效時只丟 404,不觸發 onclose,只靠它會永遠 404 循環。
    // StreamableHTTPError 不是 McpError —— 那正是「上游沒回話」的標誌。
    const e = Object.assign(new Error('Streamable HTTP error: session not found'), { code: 404 });
    const { dropped, upstream } = await callFailing(e);
    expect(dropped).toEqual([{ serverId: 'guardian', client: upstream }]);
  });

  it('丟棄時指名實例 —— 不能只給 serverId', async () => {
    // 並行呼叫共用 client:A 失敗觸發重連之後,B 這個舊呼叫才失敗。只給 serverId
    // 的話會把剛建好、可能正在被別人用的新連線關掉。
    const { dropped, upstream } = await callFailing(new Error('socket hang up'));
    expect(dropped[0].client).toBe(upstream);
  });

  it('MCP 協議錯誤不丟棄 —— server 回得了話就代表連線是通的', async () => {
    // 參數打錯就把共用 client 關掉,會連累其他正在跑的工具。這不是「多連一次」。
    const { dropped } = await callFailing(new McpError(ErrorCode.InvalidParams, 'bad arg'));
    expect(dropped).toEqual([]);
  });

  it('逾時不丟棄 —— 連線通常還活著', async () => {
    const { dropped } = await callFailing(new McpError(-32001 as ErrorCode, 'Request timed out'));
    expect(dropped).toEqual([]);
  });

  it('取消不丟棄', async () => {
    const ac = new AbortController();
    ac.abort();
    const { dropped } = await callFailing(
      Object.assign(new Error('aborted'), { name: 'AbortError' }), ac.signal);
    expect(dropped).toEqual([]);
  });

  it('list() 失敗也丟棄 —— 不然重試 list 會一直用同一個死 session', async () => {
    const upstream = await clientFor([echo]);
    vi.spyOn(upstream, 'listTools').mockRejectedValue(new Error('fetch failed'));
    const dropped: Array<{ serverId: string; client: unknown }> = [];
    const core = createToolCore({
      clients: registryOf(upstream, dropped as any), routes: ROUTES, runId: 't', log: () => {},
    });
    await core.list().catch(() => {});
    expect(dropped).toEqual([{ serverId: 'guardian', client: upstream }]);
  });
});

describe('core — list 去重', () => {
  it('同一台 server 的多個 route,一次 list 只問上游一次', async () => {
    const upstream = await clientFor([echo, { ...echo, name: 'other_tool' }]);
    const spy = vi.spyOn(upstream, 'listTools');
    const core = createToolCore({
      clients: registryOf(upstream),
      routes: [
        { id: 'repo-search', serverId: 'guardian', toolName: 'repo_search' },
        { id: 'other', serverId: 'guardian', toolName: 'other_tool' },
      ],
      runId: 't',
      log: () => {},
    });

    expect((await core.list()).map((t) => t.id)).toEqual(['repo-search', 'other']);
    // 逐 route 問的話這裡會是 2 —— playwright 的 16 個工具就是 16 次跨程序往返。
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('core — progress 真的延長逾時(行為,不是參數)', () => {
  /**
   * 一台會回報進度的上游:每 `stepMs` 送一次,共 `steps` 次,然後才回結果。
   * 前面那組測試只驗「選項有傳下去」,證明不了 SDK 真的因此不砍我們 —— 而
   * `resetTimeoutOnProgress` 曾經整條是死的,正是因為沒人驗過行為。
   */
  async function upstreamReportingProgress(steps: number, stepMs: number): Promise<Client> {
    const server = new Server({ name: 'slow', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const token = (req.params._meta as any)?.progressToken;
      for (let i = 1; i <= steps; i++) {
        await new Promise((r) => setTimeout(r, stepMs));
        if (token !== undefined) {
          await extra.sendNotification({
            method: 'notifications/progress',
            params: { progressToken: token, progress: i, total: steps },
          });
        }
      }
      return { content: [{ type: 'text', text: 'done' }] };
    });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
    await client.connect(c);
    return client;
  }

  const coreFor = (client: Client, route: Partial<ToolDecl>) => createToolCore({
    clients: registryOf(client), routes: [{ ...ROUTES[0], ...route }], runId: 't', log: () => {},
  });

  it('總耗時遠超過 timeoutMs,但持續有進度 → 不被砍', async () => {
    // 6 × 40ms = 240ms,是 timeout 的三倍。沒有 reset 的話 100ms 就死了。
    const core = coreFor(await upstreamReportingProgress(6, 40), { timeoutMs: 100 });
    const r = await core.call('repo-search', { query: 'x' });
    expect((r.content[0] as any).text).toBe('done');
  }, 10_000);

  it('沒有進度時,timeoutMs 照常生效 —— 延長不是無條件的', async () => {
    const hang = new Server({ name: 'hang', version: '1' }, { capabilities: { tools: {} } });
    hang.setRequestHandler(CallToolRequestSchema, () => new Promise(() => {})); // 永遠不回
    const [c, s] = InMemoryTransport.createLinkedPair();
    await hang.connect(s);
    const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
    await client.connect(c);
    await expect(coreFor(client, { timeoutMs: 100 }).call('repo-search', { query: 'x' }))
      .rejects.toThrow(/timed out/i);
  }, 10_000);

  it('maxTotalTimeout 擋得住「一直報進度但做不完」的上游', async () => {
    // 20 × 30ms = 600ms,遠超過 maxTotal 200ms。每次進度都會重設單次逾時,
    // 少了 maxTotalTimeout 這條呼叫會一路跑完。
    const core = coreFor(await upstreamReportingProgress(20, 30),
      { timeoutMs: 100, maxTotalTimeoutMs: 200 });
    const started = Date.now();
    await expect(core.call('repo-search', { query: 'x' })).rejects.toThrow(/Maximum total timeout/);
    // **只在收到進度時才檢查** —— 所以是「第一個超過 200ms 的進度」才死,不是剛好 200ms。
    expect(Date.now() - started).toBeLessThan(400);
  }, 10_000);
});

describe('core — 部分上游失敗', () => {
  /** 兩台 server:`up` 正常,`down` 的 listTools 依 `downError` 決定。可各自加延遲。 */
  async function twoServers(opts: { downError?: unknown; delayMs?: number } = {}) {
    const up = await clientFor([echo]);
    const down = await clientFor([{ ...echo, name: 'jira_get' }]);
    for (const c of [up, down]) {
      const real = c.listTools.bind(c);
      vi.spyOn(c, 'listTools').mockImplementation(async (...a: any[]) => {
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        if (c === down && opts.downError !== undefined) throw opts.downError;
        return real(...a);
      });
    }
    const lines: string[] = [];
    const core = createToolCore({
      clients: { async get(id) { return id === 'up' ? up : down; }, drop() {}, async closeAll() {} },
      routes: [
        { id: 'repo-search', serverId: 'up', toolName: 'repo_search' },
        { id: 'jira-get', serverId: 'down', toolName: 'jira_get' },
      ],
      runId: 't', log: (l) => lines.push(l),
    });
    return { core, lines };
  }

  it('一台連不上只拿掉它的工具,並記下略過了哪些', async () => {
    const { core, lines } = await twoServers({ downError: new Error('401 needs login') });
    expect((await core.list()).map((t) => t.id)).toEqual(['repo-search']);
    expect(lines.join('\n')).toMatch(/down 連不上\(401 needs login\)— 略過 jira-get/);
  });

  it('全部連不上照樣丟錯 —— 一個工具都沒有的 agent 不該默默跑', async () => {
    const failure = new Error('only one');
    const upOnly = await clientFor([echo]);
    vi.spyOn(upOnly, 'listTools').mockRejectedValue(failure);
    const single = createToolCore({ clients: registryOf(upOnly), routes: ROUTES, runId: 't', log: () => {} });
    await expect(single.list()).rejects.toBe(failure); // 只有一台時原樣丟(保留錯誤型別)

    const up = await clientFor([echo]);
    vi.spyOn(up, 'listTools').mockRejectedValue(new Error('A down'));
    const down = await clientFor([echo]);
    vi.spyOn(down, 'listTools').mockRejectedValue(new Error('B down'));
    const both = createToolCore({
      clients: { async get(id) { return id === 'a' ? up : down; }, drop() {}, async closeAll() {} },
      routes: [{ id: 'x', serverId: 'a', toolName: 'repo_search' }, { id: 'y', serverId: 'b', toolName: 'repo_search' }],
      runId: 't', log: () => {},
    });
    await expect(both.list()).rejects.toThrow(/所有上游都連不上:a: A down;b: B down/);
  });

  it('上游連得上但少了宣告的工具仍然 fail loud —— 那是設定錯,不是暫時故障', async () => {
    const { core } = await twoServers();
    const upOnly = await clientFor([echo]);
    const bad = createToolCore({
      clients: registryOf(upOnly),
      routes: [...ROUTES, { id: 'ghost', serverId: 'guardian', toolName: 'nope' }],
      runId: 't', log: () => {},
    });
    await expect(bad.list()).rejects.toThrow(/has no tool nope/);
    expect((await core.list()).map((t) => t.id)).toEqual(['repo-search', 'jira-get']);
  });

  it('各台平行問,不是一台接一台', async () => {
    const { core } = await twoServers({ delayMs: 300 });
    const t0 = Date.now();
    await core.list();
    expect(Date.now() - t0).toBeLessThan(550); // 序列會是 ~600ms
  });
});

describe('core — 授權失敗跟連線失敗分開', () => {
  it('OAuthLoginRequired / SDK UnauthorizedError / HTTP 401 算授權失敗;其他不算', () => {
    expect(isAuthFailure(new OAuthLoginRequired('fig'))).toBe(true);
    expect(isAuthFailure(new UnauthorizedError())).toBe(true);
    expect(isAuthFailure(Object.assign(new Error('Server returned 401 after successful authentication'), { code: 401 }))).toBe(true);
    expect(isAuthFailure(Object.assign(new Error('session not found'), { code: 404 }))).toBe(false);
    expect(isAuthFailure(new Error('fetch failed'))).toBe(false);
  });

  it('呼叫紀錄標 AUTH,訊息原樣往上(裡面寫著怎麼修)', async () => {
    const upstream = await clientFor([echo]);
    vi.spyOn(upstream, 'callTool').mockRejectedValue(new OAuthLoginRequired('fig'));
    const lines: string[] = [];
    const core = createToolCore({ clients: registryOf(upstream), routes: ROUTES, runId: 't', log: (l) => lines.push(l) });
    await expect(core.call('repo-search', { query: 'x' })).rejects.toThrow(/auth-login -- fig/);
    expect(lines.join('\n')).toMatch(/repo-search → AUTH\(需要重新授權\)/);
  });
});
