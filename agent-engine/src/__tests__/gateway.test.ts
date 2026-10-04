import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildRegistry } from '../agents/registry.js';
import { createGatewayPool, GATEWAY_ENTRY, openGatewayConfig } from '../run/gateway.js';
import { claudeCli } from '../runtimes/claudeCli.js';
import { GATEWAY_SERVER_NAME } from '../shared/names.js';
import type { Catalog } from 'mcp-hub';

// hub 的 fixture。從 package 解析,不寫死跨 package 的相對路徑。
const FIXTURE_ROOT = join(dirname(require.resolve('mcp-hub/package.json')), 'src', '__tests__', 'fixture');
const MANIFESTS = join(FIXTURE_ROOT, 'manifests');

const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const serverOf = (path: string) => read(path).mcpServers[GATEWAY_SERVER_NAME];

describe('per-take gateway 設定', () => {
  it('沒宣告工具的 agent 不開 gateway', () => {
    // 不必為了形式統一硬產一份空設定 —— 少一個子程序就是少一個會壞的東西。
    for (const tools of [undefined, []]) {
      const s = openGatewayConfig({ agentId: 'none', root: FIXTURE_ROOT, ...(tools ? { tools } : {}) });
      expect(s.configPath).toBeUndefined();
      s.close();
    }
  });

  it('入口指向套件根的 build 產物,不是專案根', () => {
    // 這是裝成 node_modules 相依之後唯一會對的路徑。
    const s = openGatewayConfig({ agentId: 'limited', tools: ['up-echo'], root: FIXTURE_ROOT });
    try {
      expect(serverOf(s.configPath!).args[0]).toBe(GATEWAY_ENTRY);
      expect(GATEWAY_ENTRY).not.toContain(FIXTURE_ROOT);
    } finally { s.close(); }
  });

  it('子程序被告知要用哪個專案根找 manifests', () => {
    const s = openGatewayConfig({ agentId: 'limited', tools: ['up-echo'], root: FIXTURE_ROOT });
    try {
      expect(serverOf(s.configPath!).env.AGENT_ENGINE_ROOT).toBe(FIXTURE_ROOT);
      expect(serverOf(s.configPath!).args).toEqual([GATEWAY_ENTRY, '--tools', 'up-echo']);
    } finally { s.close(); }
  });

  it('允許清單直接傳給子程序 —— 不在磁碟 manifest 裡的 inline agent 也拿得到工具', async () => {
    // 回歸:原本傳 `--agent <id>`,子程序會去 manifests/agents/ 重讀,
    // 只存在 `EngineConfig.agents` 的 inline agent 會找不到而啟動失敗。
    if (!existsSync(GATEWAY_ENTRY)) return; // 沒 build 時跳過(npm test 的 pretest 會先編)
    const s = openGatewayConfig({
      agentId: 'inline-only', tools: ['code-echo'],
      toolDefinitions: [{ id: 'code-echo', serverId: 'upstream', toolName: 'echo' }], root: FIXTURE_ROOT,
      env: { E2E_FIXTURE_DIR: FIXTURE_ROOT, E2E_TAG: 'engine-inline-agent' },
    });
    const server = serverOf(s.configPath!);
    const client = new Client({ name: 'gateway-test', version: '1.0.0' }, { capabilities: {} });
    try {
      await client.connect(new StdioClientTransport({
        command: server.command, args: server.args,
        env: { ...process.env, ...server.env } as Record<string, string>, stderr: 'ignore',
      }));
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['code-echo']);
    } finally {
      await client.close().catch(() => {});
      s.close();
    }
  }, 30_000);

  it('env 覆寫會帶進去 —— ${VAR} 插值不必賭繼承', () => {
    const s = openGatewayConfig({
      agentId: 'limited', tools: ['up-echo'], root: FIXTURE_ROOT,
      env: { E2E_FIXTURE_DIR: '/somewhere', SKIPPED: undefined },
    });
    try {
      const env = serverOf(s.configPath!).env;
      expect(env.E2E_FIXTURE_DIR).toBe('/somewhere');
      // undefined 不寫進去,不然會變成字串 "undefined"。
      expect('SKIPPED' in env).toBe(false);
    } finally { s.close(); }
  });

  it('不把整包 process.env 複製進設定檔', () => {
    // 那個檔在 /tmp,把憑證寫進去是沒必要的暴露;子程序本來就繼承得到。
    process.env.ENGINE_GATEWAY_SECRET = 'must-not-leak';
    const s = openGatewayConfig({ agentId: 'limited', tools: ['up-echo'], root: FIXTURE_ROOT });
    try {
      expect(readFileSync(s.configPath!, 'utf8')).not.toContain('must-not-leak');
    } finally {
      s.close();
      delete process.env.ENGINE_GATEWAY_SECRET;
    }
  });

  it('close 之後暫存檔就不在了,而且可以重複呼叫', () => {
    const s = openGatewayConfig({ agentId: 'limited', tools: ['up-echo'], root: FIXTURE_ROOT });
    const path = s.configPath!;
    expect(existsSync(path)).toBe(true);
    s.close();
    expect(existsSync(path)).toBe(false);
    expect(() => s.close()).not.toThrow();
  });
});

describe('gateway pool（給 engine.close() 收尾用）', () => {
  it('take 沒收乾淨時 closeAll 會補掉', () => {
    // 「take 在 finally 之前就炸了」與「宿主直接關 engine」兩種情況,
    // 不補的話 /tmp 會留下一堆設定檔。
    const pool = createGatewayPool();
    const a = pool.acquire({ agentId: 'limited', tools: ['up-echo'], root: FIXTURE_ROOT });
    const b = pool.acquire({ agentId: 'slowpoke', tools: ['up-slow'], root: FIXTURE_ROOT });
    expect(pool.size).toBe(2);

    pool.closeAll();
    expect(pool.size).toBe(0);
    expect(existsSync(a.configPath!)).toBe(false);
    expect(existsSync(b.configPath!)).toBe(false);
  });

  it('正常收掉的 session 不會留在池子裡', () => {
    const pool = createGatewayPool();
    const s = pool.acquire({ agentId: 'limited', tools: ['up-echo'], root: FIXTURE_ROOT });
    s.close();
    expect(pool.size).toBe(0);
  });

  it('沒開 gateway 的 take 不佔池子', () => {
    const pool = createGatewayPool();
    pool.acquire({ agentId: 'none', tools: [], root: FIXTURE_ROOT });
    expect(pool.size).toBe(0);
  });
});

describe('in-memory 工具在子程序家族不可達', () => {
  const catalog: Catalog = {
    servers: [
      { id: 'upstream', transport: 'stdio', command: 'node' },
      { id: 'host', transport: 'in-memory' },
    ],
    tools: [
      { id: 'up-echo', serverId: 'upstream', toolName: 'echo' },
      { id: 'up-empty', serverId: 'upstream', toolName: 'empty' },
      { id: 'up-fail', serverId: 'upstream', toolName: 'fail' },
      { id: 'up-slow', serverId: 'upstream', toolName: 'slow' },
      { id: 'up-secret', serverId: 'upstream', toolName: 'secret' },
      { id: 'host-echo', serverId: 'host', toolName: 'host_echo' },
    ],
  };

  it('建立 engine 時就擋下,不留到 take 中途才 fail', () => {
    // 不擋的話,症狀是子程序裡的 gateway 在 tools/list 報「server has no tool
    // host_echo」—— 看不出真正的原因是「這種工具過不了程序邊界」。
    try {
      buildRegistry({ manifestDir: MANIFESTS, runtime: claudeCli, catalog });
      expect.unreachable();
    } catch (e: any) {
      expect(e.kind).toBe('capability');
      expect(e.message).toMatch(/hosted.*host-echo.*傳不過去/s);
      expect(e.message).toMatch(/stdio MCP server/);
    }
  });

  it('只用外部 server 的 agent 不受影響 —— 擋的是不可達,不是「有宣告 in-memory」', () => {
    // catalog 裡照樣有那台 in-memory server,但這個 agent 沒用到它的工具。
    expect(() => buildRegistry({
      manifestDir: join(__dirname, 'no-such-dir'), // 不存在 = 沒有檔案宣告
      runtime: claudeCli,
      catalog,
      inline: [{ id: 'external-only', tools: ['up-echo'], flows: [], interactions: [] }],
    })).not.toThrow();
  });
});
