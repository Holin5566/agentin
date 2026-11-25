import { defineAgent } from '../agents/manifest.js';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentEngine } from '../engine.js';
import { createMemoryStore } from '../artifacts/memory.js';
import { buildRegistry } from '../agents/registry.js';
import { createVercelAiCli, FS_READ_TOOLS } from '../runtimes/vercelAiCli.js';
import { GATEWAY_ENTRY } from '../run/gateway.js';
import type { Engine } from '../types.js';
import { startFakeOpenAi } from './helpers/fakeOpenAi.js';
import { RUNNER } from './helpers/runner.js';

/**
 * 裸模型沒有 Read / Grep,`filesystem: 'read-only'` 靠 mcp-hub 的唯讀檔案工具表達。
 * 這裡走**真的 gateway + 真的 fs 工具 + 假模型**:manifest 只寫意圖,runtime 把它換成 gateway 工具名單。
 */

const dirs: string[] = [];
let engine: Engine | undefined;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await engine?.close(); engine = undefined;
  for (const c of closers.splice(0)) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const FS_SERVER = join(GATEWAY_ENTRY, '..', 'fsServer.js'); // mcp-hub/dist/bin/fsServer.js

/** 一個專案根:有 `manifests/mcp-servers/fs-readonly.json`(指到 mcp-hub 的 build 產物)和幾個檔案。 */
function projectRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vai-fs-'))); dirs.push(root);
  mkdirSync(join(root, 'manifests', 'mcp-servers'), { recursive: true });
  writeFileSync(join(root, 'manifests', 'mcp-servers', 'fs-readonly.json'), JSON.stringify({
    id: 'fs-readonly', transport: 'stdio', command: 'node', args: [FS_SERVER],
    env: { FS_READ_ROOTS: '${AGENT_ENGINE_ROOT}' },
    tools: { 'fs-read_file': 'fs_read_file', 'fs-list_dir': 'fs_list_dir', 'fs-glob': 'fs_glob', 'fs-grep': 'fs_grep' },
  }));
  writeFileSync(join(root, 'notes.txt'), 'the answer is 42\nsecond line\n');
  writeFileSync(join(root, '.env'), 'TOKEN=very-secret');
  return root;
}

const reader = (extra: object = {}) => ({ id: 'reader', tools: [], capabilities: { filesystem: 'read-only', shell: false }, flows: [], interactions: [], ...extra }) as any;
const mk = (root: string, url: string) => createAgentEngine({
  root, runtime: createVercelAiCli({ baseUrl: url, model: 'm', runnerPath: RUNNER, maxTokens: 500 }),
  agents: [reader()], log: () => {}, artifacts: createMemoryStore(),
});

describe('registry:runtime 補的 gateway 工具', () => {
  const rt = createVercelAiCli({ baseUrl: 'http://x/v1', model: 'm' });
  const catalogWith = (ids: string[]) => ({ servers: [{ id: 's', transport: 'stdio' as const, command: 'x' }], tools: ids.map((id) => ({ id, serverId: 's', toolName: id })) });
  const build = (agents: any[], catalog: any) => buildRegistry({ manifestDir: join(__dirname, 'fixture', 'manifests'), runtime: rt, inline: agents, catalog });

  it('read-only 併進該 agent 的允許清單(保留它自己宣告的工具、去重)', () => {
    const reg = build([reader({ tools: ['fs-grep', 'other'] })], catalogWith([...FS_READ_TOOLS, 'other']));
    expect(reg.get('reader').tools).toEqual(['fs-grep', 'other', 'fs-read_file', 'fs-list_dir', 'fs-glob']);
  });

  it('「全部禁用」/ 沒宣告 capabilities:不補任何工具', () => {
    const reg = build([
      reader({ id: 'deny', capabilities: { filesystem: 'none', shell: false } }),
      reader({ id: 'nocaps', capabilities: undefined }),
    ], catalogWith([]));
    expect(reg.get('deny').tools).toEqual([]);
    expect(reg.get('nocaps').tools).toEqual([]);
  });

  it('catalog 沒宣告 fs 工具 → 載入就失敗並指出怎麼修(不是半夜才發現模型沒工具)', () => {
    expect(() => build([reader()], catalogWith(['unrelated']))).toThrow(/要靠 gateway 工具表達.*fs-read_file.*manifests\/mcp-servers/s);
  });

  it('claude 不補任何工具(原生工具表達,行為不變)', () => {
    const reg = buildRegistry({
      manifestDir: join(__dirname, 'fixture', 'manifests'), runtime: { name: 'c', capabilities: { skills: true, nativeTools: true, filesystemPolicy: 'tool-list', maxSteps: false }, command: () => ({ file: 'x', args: [] }) },
      inline: [reader()], catalog: catalogWith([]),
    });
    expect(reg.get('reader').tools).toEqual([]);
  });
});

describe('能力不符的故障範圍 = 一個 agent', () => {
  it('同一個 vercel-ai engine 上,shell / workspace-write 的 agent 失敗(capability),不影響正常的 agent', async () => {
    const srv = await startFakeOpenAi(() => ({ kind: 'text', text: '你好' }));
    closers.push(srv.close);
    const caps = (c: object) => ({ tools: [], flows: [], interactions: [], capabilities: c }) as any;
    engine = createAgentEngine({
      root: projectRoot(), runtime: createVercelAiCli({ baseUrl: srv.url, model: 'm', runnerPath: RUNNER, maxTokens: 500 }),
      agents: [
        { id: 'chat', ...caps({ filesystem: 'none', shell: false }) },
        { id: 'needs-shell', ...caps({ filesystem: 'none', shell: true }) },
        { id: 'needs-write', ...caps({ filesystem: 'workspace-write', shell: false }) },
      ],
      log: () => {}, artifacts: createMemoryStore(),
    });

    expect(await engine.runTake({ agent: defineAgent({ id: 'chat', tools: [], capabilities: { filesystem: 'none', shell: false } }), prompt: 'hi' })).toMatchObject({ status: 'ok', raw: '你好' });
    for (const agent of ['needs-shell', 'needs-write']) {
      const r = await engine.runTake({ agent: defineAgent({ id: agent, tools: [], capabilities: agent === 'needs-shell' ? { shell: true } : { filesystem: 'workspace-write' } }), prompt: 'hi' });
      expect(r.status).toBe('error');
      expect(r.error).toMatchObject({ kind: 'capability' });
    }
    // 失敗的 take 一次都沒打到模型;壞 agent 之後,正常 agent 仍可用。
    expect(srv.requests).toHaveLength(1);
    expect(await engine.runTake({ agent: defineAgent({ id: 'chat', tools: [], capabilities: { filesystem: 'none', shell: false } }), prompt: 'again' })).toMatchObject({ status: 'ok' });
  });
});

describe('端到端:裸模型經 gateway 讀專案檔案', () => {
  it('模型叫 fs-read_file → 讀到真的檔案內容 → 回答;模型只看得到那四個唯讀工具', async () => {
    const root = projectRoot();
    const srv = await startFakeOpenAi((n) => n === 0 ? { kind: 'call', name: 'fs-read_file', args: '{"path":"notes.txt"}' } : { kind: 'text', text: 'It says 42' });
    closers.push(srv.close);
    engine = mk(root, srv.url);
    const r = await engine.runTake({ agent: defineAgent({ id: 'reader', tools: [], capabilities: { filesystem: 'read-only', shell: false } }), prompt: 'what is in notes.txt?' });

    expect(r).toMatchObject({ status: 'ok', raw: 'It says 42' });
    expect(srv.requests[0].body.tools.map((t: any) => t.function.name).sort()).toEqual([...FS_READ_TOOLS].sort());
    expect(JSON.stringify(srv.requests[1].body.messages)).toContain('the answer is 42');
  });

  it('沙箱:模型要讀 .env / 專案外的檔案 → 工具回「存取被拒」給模型,不洩漏內容、take 不中斷', async () => {
    const root = projectRoot();
    const srv = await startFakeOpenAi((n) =>
      n === 0 ? { kind: 'call', name: 'fs-read_file', args: '{"path":".env"}' }
        : n === 1 ? { kind: 'call', name: 'fs-read_file', args: '{"path":"/etc/hosts"}' }
        : { kind: 'text', text: 'cannot' });
    closers.push(srv.close);
    engine = mk(root, srv.url);
    const r = await engine.runTake({ agent: defineAgent({ id: 'reader', tools: [], capabilities: { filesystem: 'read-only', shell: false } }), prompt: 'read secrets' });

    expect(r).toMatchObject({ status: 'ok', raw: 'cannot' });
    const second = JSON.stringify(srv.requests[1].body.messages);
    const third = JSON.stringify(srv.requests[2].body.messages);
    expect(second).toContain('存取被拒');
    expect(third).toContain('存取被拒');
    expect(second + third).not.toContain('very-secret');
  });

  it('grep + glob 走得通', async () => {
    const root = projectRoot();
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'x.ts'), 'export const findme = 1;\n');
    const srv = await startFakeOpenAi((n) =>
      n === 0 ? { kind: 'call', name: 'fs-grep', args: '{"pattern":"findme"}' }
        : n === 1 ? { kind: 'call', name: 'fs-glob', args: '{"pattern":"*.ts"}' }
        : { kind: 'text', text: 'done' });
    closers.push(srv.close);
    engine = mk(root, srv.url);
    await engine.runTake({ agent: defineAgent({ id: 'reader', tools: [], capabilities: { filesystem: 'read-only', shell: false } }), prompt: 'p' });
    expect(JSON.stringify(srv.requests[1].body.messages)).toContain('src/x.ts:1:export const findme = 1;');
    expect(JSON.stringify(srv.requests[2].body.messages)).toContain('src/x.ts');
  });
});
