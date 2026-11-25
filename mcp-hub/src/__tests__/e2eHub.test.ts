/**
 * in-process 端到端:`openGateway()` 對真實 manifest 與真實 stdio 上游。
 *
 * 跟 `e2eGateway.test.ts` 互補 —— 那條驗跨程序(`claude -p` 走的路),這條驗
 * 程式端(宿主自己呼叫工具走的路)。兩條共用同一個 `core.ts`,但**有兩件事只有
 * 這一側測得到**:
 *
 *   - 取消。`AbortSignal` 是 JS 物件,跨程序傳不過去。
 *   - 宿主注入的 builtin 工具。同上,傳不了 JS 物件。
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BuiltinTool } from '../types.js';
import type { Hub } from '../hub.js';

const FIXTURE = join(__dirname, 'fixture');

const hostEcho: BuiltinTool = {
  name: 'host_echo',
  description: '宿主注入的工具',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  execute: async (args) => `host: ${args.text}`,
};

/**
 * `MCP_SERVERS_DIR` 在載入時求值,所以要換 manifest 根就得
 * 重載模組。(這個限制本身值得記一筆:engine 的 `root` 之後應該收成參數。)
 */
/**
 * 各情境的允許清單。原本放在 fixture 的 agents/*.json,由 hub 用 `--agent` 去讀;
 * hub 已經不知道 agent 是什麼,允許清單改由呼叫端直接給。
 */
const ALLOW = {
  limited: ['up-echo', 'up-empty', 'up-fail'],
  none: [] as string[],
  hosted: ['host-echo'],
  slowpoke: ['up-slow'],
};

async function openOnFixture(tools: string[], builtinTools: BuiltinTool[] = []): Promise<Hub> {
  process.env.AGENT_ENGINE_ROOT = FIXTURE;
  vi.resetModules();
  const { openGateway } = await import('../hub.js');
  return openGateway({
    tools,
    builtinTools,
    log: () => {},
    env: { E2E_FIXTURE_DIR: FIXTURE, E2E_TAG: `hub-${randomUUID()}` },
  });
}

let hub: Hub | undefined;
afterEach(async () => {
  await hub?.close().catch(() => {});
  hub = undefined;
  delete process.env.AGENT_ENGINE_ROOT;
  vi.resetModules();
});

describe('宿主注入的工具（只有 in-process 這條路有）', () => {
  it('注入之後真的叫得到,而且對外露出的是 manifest 的 tool id', async () => {
    hub = await openOnFixture(ALLOW.hosted, [hostEcho]);
    expect((await hub.list()).map((t) => t.id)).toEqual(['host-echo']);
    // 對外是 host-echo,實作叫 host_echo —— core 負責翻譯。
    expect(await hub.call('host-echo', { text: 'hi' })).toBe('host: hi');
  });

  it('沒注入實作時 fail loud,不會靜默少一個工具', async () => {
    // 同一份 manifest、同一份允許清單,只是沒把實作傳進去。
    hub = await openOnFixture(ALLOW.hosted, []);
    await expect(hub.list()).rejects.toThrow(/has no tool host_echo/);
  });
});

describe('取消（只有 in-process 這條路傳得了 signal）', () => {
  it('AbortError 原樣往上,不被包成工具失敗', async () => {
    // 這條若壞掉,「使用者按了停止」會被宿主讀成「工具壞了」—— 兩者的後續處置
    // 完全不同(前者不該重試,也不該計入失敗)。
    hub = await openOnFixture(ALLOW.slowpoke);
    const ac = new AbortController();
    const pending = hub.call('up-slow', {}, ac.signal);
    setTimeout(() => ac.abort(), 300);

    await expect(pending).rejects.toSatisfy((e: any) => {
      // 重點是它**不是** ToolCallFailed;kind 欄位存在就代表被包過了。
      expect(e?.name).not.toBe('ToolCallFailed');
      expect(e?.kind).toBeUndefined();
      return true;
    });
  }, 20_000);
});

describe('失敗語意', () => {
  it('未授權的工具回 denied,而且訊息列出實際可用的', async () => {
    hub = await openOnFixture(ALLOW.slowpoke);
    await expect(hub.call('up-secret', {})).rejects.toMatchObject({
      name: 'ToolCallFailed',
      kind: 'denied',
    });
    await expect(hub.call('up-secret', {})).rejects.toThrow(/up-slow/);
  });

  it('工具回報失敗是 tool-error,不是 transport', async () => {
    hub = await openOnFixture(ALLOW.limited);
    await expect(hub.call('up-fail', {})).rejects.toMatchObject({
      name: 'ToolCallFailed',
      kind: 'tool-error',
    });
  });

  it('上游回 JSON-RPC 錯誤(參數不合法)是 protocol,不是 transport —— 連線沒丟,原樣重試會得到同一個錯', async () => {
    hub = await openOnFixture(['up-reject', 'up-echo']);
    await expect(hub.call('up-reject', {})).rejects.toMatchObject({
      name: 'ToolCallFailed', kind: 'protocol', message: expect.stringMatching(/bad argument/),
    });
    // 同一條連線還能用:沒有被當成死連線丟掉
    expect(await hub.call('up-echo', { text: 'still here' })).toBe('echoed: still here');
  });

  it('查無資料是正常回傳,不 throw', async () => {
    hub = await openOnFixture(ALLOW.limited);
    expect(await hub.call('up-empty', {})).toBe('(no matches)');
  });
});
