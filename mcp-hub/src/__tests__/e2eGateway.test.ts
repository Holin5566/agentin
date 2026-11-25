/**
 * 跨程序端到端:真的起 `dist/bin/entry.js`,真的連一台 stdio 上游。
 *
 * **為什麼要有這一條**:其餘測試都在同一個程序裡驗 core 的行為,但正式路徑是
 * `claude -p --mcp-config` 拉起一個獨立的 gateway 程序。允許清單、三態、
 * 連線清理在那條路上生不生效,in-process 測試證明不了 —— 而那條路正是唯一
 * 真的擋得住模型亂用工具的地方。
 *
 * 這條先前只用手動腳本驗過,現在固化。
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PACKAGE_ROOT } from '../shared/paths.js';

const FIXTURE = join(__dirname, 'fixture');
const ENTRY = join(PACKAGE_ROOT, 'dist', 'bin', 'entry.js');

/**
 * entry.js 是 build 產物。`npm test` 有 `pretest` 會先編,但直接跑 `npx vitest`
 * 不會 —— 那種情況說清楚為什麼跳過,不要讓它看起來像測試通過。
 */
const built = existsSync(ENTRY);
const describeE2E = built ? describe : describe.skip;
if (!built) console.warn(`[e2e] 跳過跨程序測試 —— 缺 ${ENTRY}(先跑 npm run build)`);

/**
 * 開一個連到 gateway 的 client。gateway 自己會再去拉上游。
 *
 * `tag` 會被帶進上游程序的 argv,讓清理測試能只找**自己那一條**的殘留 ——
 * 只比對 fixture 路徑的話,會撈到其他測試還開著的連線而誤判。
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

async function connect(tools: string[], tag: string = randomUUID()): Promise<Client> {
  const client = new Client({ name: 'e2e-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY, '--tools', tools.join(',')],
    env: {
      ...process.env,
      // gateway 要靠這個找 fixture 的 manifests(而不是本專案的)。
      AGENT_ENGINE_ROOT: FIXTURE,
      // upstream.json 的 args 用 ${E2E_FIXTURE_DIR} 指到 server 腳本。
      E2E_FIXTURE_DIR: FIXTURE,
      E2E_TAG: tag,
    } as Record<string, string>,
    // 上游與 gateway 的 stderr 不要污染測試輸出。
    stderr: 'ignore',
  }));
  return client;
}

/** 目前還活著、帶這個 tag 的上游程序數。 */
function liveUpstreams(tag: string): number {
  const ps = spawnSync('/bin/sh', ['-c', `ps -eo args | grep -F -- '--tag=${tag}' | grep -v grep || true`], {
    encoding: 'utf8',
  });
  return ps.stdout.split('\n').filter((l) => l.trim()).length;
}

const textOf = (result: any): string =>
  (result?.content ?? []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n');

describeE2E('跨程序 gateway', () => {
  let limited: Client;

  beforeAll(async () => { limited = await connect(ALLOW.limited); }, 30_000);
  afterAll(async () => { await limited?.close().catch(() => {}); });

  describe('允許清單', () => {
    it('只列得到允許清單裡的工具', async () => {
      const names = (await limited.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual(['up-echo', 'up-empty', 'up-fail']);
    });

    it('上游有、但不在允許清單的工具不會外洩', async () => {
      const names = (await limited.listTools()).tools.map((t) => t.name);
      // up-secret 與 up-slow 都宣告在 server manifest 上,只是沒給這個 agent。
      expect(names).not.toContain('up-secret');
      expect(names).not.toContain('up-slow');
    });

    it('直接呼叫未授權的工具會被擋下,而且不會轉發到上游', async () => {
      // 這是整個 gateway 存在的理由:不是 prompt 拜託模型別用,是協議層沒給。
      await expect(limited.callTool({ name: 'up-secret', arguments: {} }))
        .rejects.toThrow(/tool not available/);
      // 上游那支工具回 'ALLOWLIST_BREACH';只要看到它就代表真的被轉發過去了。
      const probe = textOf(await limited.callTool({ name: 'up-echo', arguments: { text: 'still alive' } }));
      expect(probe).not.toContain('ALLOWLIST_BREACH');
      expect(probe).toBe('echoed: still alive');
    });

    it('空的允許清單一個工具都沒有', async () => {
      const client = await connect(ALLOW.none);
      try {
        expect((await client.listTools()).tools).toEqual([]);
        await expect(client.callTool({ name: 'up-echo', arguments: {} }))
          .rejects.toThrow(/tool not available/);
      } finally {
        await client.close();
      }
    }, 30_000);
  });

  describe('三態語意跨程序仍然分得開', () => {
    it('正常結果', async () => {
      const r: any = await limited.callTool({ name: 'up-echo', arguments: { text: 'hi' } });
      expect(r.isError).toBeFalsy();
      expect(textOf(r)).toBe('echoed: hi');
    });

    it('查無資料是成功,不是失敗', async () => {
      // 這條若壞掉,agent 會把「RAG 掛了」讀成「沒有這段程式碼」。
      const r: any = await limited.callTool({ name: 'up-empty', arguments: {} });
      expect(r.isError).toBeFalsy();
      expect(textOf(r)).toBe('(no matches)');
    });

    it('工具失敗是 isError,不會被壓成查無', async () => {
      const r: any = await limited.callTool({ name: 'up-fail', arguments: {} });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain('upstream exploded');
    });
  });

  describe('已知限制', () => {
    it('宿主注入的 builtin 工具在跨程序路徑上不可用', async () => {
      // 釘住而不是假裝沒這回事:entry.js 是獨立程序,收不到宿主的 JS 物件。
      // 宣告了 in-memory server 的 agent 會在 tools/list 當場 fail loud ——
      // 這比靜默少一個工具好(見 core.ts 的 route 檢查)。
      // 要讓 claude -p 用到宿主工具,得把它做成真正的 stdio server。
      const client = await connect(ALLOW.hosted);
      try {
        await expect(client.listTools()).rejects.toThrow();
      } finally {
        await client.close();
      }
    }, 30_000);
  });

  describe('清理', () => {
    it('client 離線後 gateway 與它拉起的上游都會收掉', async () => {
      const tag = `cleanup-${randomUUID()}`;
      const client = await connect(ALLOW.limited, tag);
      await client.callTool({ name: 'up-echo', arguments: { text: 'x' } });

      // 先確認真的抓得到 —— 否則「關掉之後找不到」會是空過的斷言。
      expect(liveUpstreams(tag)).toBe(1);

      await client.close();

      // entry.ts 掛了 stdin 的 end / close:管線斷掉就 shutdown 並關上游連線。
      // 沒有這條的話,gateway 被 SIGKILL 或崩潰時會留下孤兒程序。
      const deadline = Date.now() + 10_000;
      while (liveUpstreams(tag) > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(liveUpstreams(tag)).toBe(0);
    }, 30_000);
  });
});
