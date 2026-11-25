import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRegistry } from '../agents/registry.js';
import { claudeCli } from '../runtimes/claudeCli.js';
import { codexCli } from '../runtimes/codexCli.js';
import { EngineError, type SpawnRuntime } from '../types.js';
import type { Catalog } from 'mcp-hub';

/**
 * 能力協商的重點不是「有沒有擋」,是**在什麼時候擋**:在 `buildRegistry()`,也就是
 * agent 第一次被用到、spawn 之前(或 `engine.check()`),不留到某個 take 跑了十分鐘才空手而回。
 */

// hub 的 fixture(mcp-servers + agents)。從 package 解析,不寫死跨 package 的相對路徑。
const FIXTURE = join(join(dirname(require.resolve('mcp-hub/package.json')), 'src', '__tests__', 'fixture'), 'manifests');

/** fixture 的 mcp-servers 宣告了這些 tool id。 */
const catalog: Catalog = {
  servers: [{ id: 'upstream', transport: 'stdio', command: 'node' }],
  tools: ['up-echo', 'up-empty', 'up-fail', 'up-slow', 'up-secret', 'host-echo'].map((id) => ({
    id, serverId: 'upstream', toolName: id,
  })),
};

const build = (inline?: any[], runtime: SpawnRuntime = claudeCli) =>
  buildRegistry({ manifestDir: FIXTURE, runtime, catalog, ...(inline ? { inline } : {}) });

describe('載入與合併', () => {
  it('讀得到 fixture 裡的 agent', () => {
    expect(build().ids()).toEqual(['hosted', 'limited', 'none', 'slowpoke']);
  });

  it('inline 宣告可以不寫檔', () => {
    const reg = build([{ id: 'inline-one', tools: [], flows: [], interactions: [] }]);
    expect(reg.ids()).toContain('inline-one');
    expect(reg.get('inline-one').id).toBe('inline-one');
  });

  it('inline 與檔案 id 撞了要報錯,不靜默讓某一邊贏', () => {
    // 靜默覆寫會讓人改了檔案卻不生效,而那種錯只有在行為不對時才發現。
    expect(() => build([{ id: 'limited', tools: [], flows: [], interactions: [] }]))
      .toThrow(/同時存在於 manifests\/ 與 inline/);
  });

  it('找不到的 agent 會列出有哪些', () => {
    expect(() => build().get('nope')).toThrow(/沒有 agent "nope".*limited/s);
  });
});

describe('manifest 欄位驗證', () => {
  it('最上層打錯的欄位要擋 —— 不能變成一個寫著限制、實際全開的 agent', () => {
    expect(() => build([{ id: 'typo', capabilites: { shell: false } }]))
      .toThrow(/inline\[0\].*未知欄位 "capabilites"/);
  });

  it('prompt 不屬於 manifest:舊的 promptFile 會被擋下,而不是靜默忽略', () => {
    expect(() => build([{ id: 'legacy', promptFile: 'prompts/legacy.md' }]))
      .toThrow(/未知欄位 "promptFile"/);
  });

  it('磁碟上的檔也一樣', () => {
    const dir = mkdtempSync(join(tmpdir(), 'manifests-'));
    mkdirSync(join(dir, 'agents'));
    writeFileSync(join(dir, 'agents', 'typo.json'), JSON.stringify({ id: 'typo', toosl: [] }));
    expect(() => buildRegistry({ manifestDir: dir, runtime: claudeCli, catalog }))
      .toThrow(/agents\/typo\.json.*未知欄位 "toosl"/);
  });

  it('同一個檔裡寫了兩次 tools:擋下來,不讓前一份允許清單靜默消失', () => {
    const dir = mkdtempSync(join(tmpdir(), 'manifests-'));
    mkdirSync(join(dir, 'agents'));
    writeFileSync(join(dir, 'agents', 'dup.json'), '{"id":"dup","tools":["up-echo"],"tools":[]}');
    expect(() => buildRegistry({ manifestDir: dir, runtime: claudeCli, catalog }))
      .toThrow(/agents\/dup\.json: 重複的 key "tools"/);
  });

  it('inline 宣告跟檔案走同一套驗證,錯誤是 config', () => {
    try {
      build([{ id: 'bad', capabilities: { filesystem: 'everything' } }]);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EngineError);
      expect((e as EngineError).kind).toBe('config');
    }
  });

  it('id / reportAs 會進路徑,只收安全字元', () => {
    expect(() => build([{ id: 'a/b' }])).toThrow(/id 只能用英數字/);
    expect(() => build([{ id: 'ok', reportAs: 'has space' }])).toThrow(/reportAs 只能用英數字/);
    expect(() => build([{ id: 'ok', reportAs: '..' }])).toThrow(/reportAs/);
  });

  it('只選部分 agent(agentIds)時 inline 也會驗', () => {
    expect(() => buildRegistry({ manifestDir: FIXTURE, runtime: claudeCli, catalog,
      inline: [{ id: 'x', shel: true } as any], agentIds: ['x'] })).toThrow(/未知欄位 "shel"/);
  });

  it('驗證不改動宿主傳進來的物件', () => {
    const decl = { id: 'pure' };
    build([decl]);
    expect(decl).toEqual({ id: 'pure' });
  });
});

describe('工具交叉驗證', () => {
  it('引用不存在的 tool id 在建立時就炸', () => {
    // 不擋的話症狀出現在很後面:模型說「我沒有這個工具」,但 manifest 明明寫了。
    expect(() => build([{ id: 'typo', tools: ['up-ecko'], flows: [], interactions: [] }]))
      .toThrow(/agent "typo".*未定義的 tool id: up-ecko/s);
  });

  it('報的是 config 不是 capability —— 打錯字不是能力問題', () => {
    try {
      build([{ id: 'typo', tools: ['nope'], flows: [], interactions: [] }]);
      expect.unreachable();
    } catch (e: any) {
      expect(e).toBeInstanceOf(EngineError);
      expect(e.kind).toBe('config');
    }
  });
});

describe('能力協商', () => {
  it('claude 有 plugin 機制,宣告 skills 可以過', () => {
    expect(() => build([{ id: 'needs-skill', tools: [], skills: ['elk'], flows: [], interactions: [] }]))
      .not.toThrow();
  });

  it('codex 沒有 plugin 機制,同一份宣告在建立時就被擋下', () => {
    try {
      build([{ id: 'needs-skill', tools: [], skills: ['elk'], flows: [], interactions: [] }], codexCli);
      expect.unreachable();
    } catch (e: any) {
      expect(e.kind).toBe('capability');
      expect(e.message).toMatch(/needs-skill.*elk.*codex-cli/s);
    }
  });

  it('adapter 自己表達不了的限制也會在這裡現形', () => {
    // codex 的沙箱管的是「指令能不能寫」不是「能不能執行」,所以 shell: false
    // 翻譯不出來。這個知識在 codexCli 裡,協商不另外維護一份能力矩陣 ——
    // 兩份同一個事實遲早分岔,所以直接試組一次指令問它。
    try {
      build([{ id: 'no-shell', tools: [], capabilities: { shell: false }, flows: [], interactions: [] }], codexCli);
      expect.unreachable();
    } catch (e: any) {
      expect(e.kind).toBe('capability');
      expect(e.message).toMatch(/no-shell.*shell: false/s);
    }
  });

  it('同一份宣告換成 claude 就過 —— 它用工具名單表達得了', () => {
    expect(() => build(
      [{ id: 'no-shell', tools: [], capabilities: { shell: false }, flows: [], interactions: [] }],
      claudeCli,
    )).not.toThrow();
  });

  it('runtime 完全不支援檔案系統限制時,宣告了就拒絕', () => {
    const bare: SpawnRuntime = {
      name: 'bare',
      capabilities: { skills: false, nativeTools: false, filesystemPolicy: 'none', maxSteps: true },
      command: () => ({ file: 'bare', args: [] }),
    };
    expect(() => build(
      [{ id: 'ro', tools: [], capabilities: { filesystem: 'read-only' }, flows: [], interactions: [] }],
      bare,
    )).toThrow(/無法表達檔案系統限制/);
  });

  it('沒宣告 capabilities 的 agent 在任何 runtime 上都過', () => {
    const bare: SpawnRuntime = {
      name: 'bare',
      capabilities: { skills: false, nativeTools: false, filesystemPolicy: 'none', maxSteps: true },
      command: () => ({ file: 'bare', args: [] }),
    };
    expect(() => build(undefined, bare)).not.toThrow();
  });
});
