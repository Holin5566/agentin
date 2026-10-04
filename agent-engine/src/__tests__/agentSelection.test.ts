/**
 * `agentIds`:engine 只載入並驗證自己要用的 agent。
 *
 * 動機(2026-09-25 review):一般對話只用 inline 的 guardian-conversation,卻會載入整個
 * `<root>/manifests/`。只要某個 Jira agent 的工具宣告寫錯,對話功能也跟著起不來。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRegistry, validateManifests } from '../agents/registry.js';
import { claudeCli } from '../runtimes/claudeCli.js';
import { createAgentEngine } from '../engine.js';
import { createMemoryStore } from '../artifacts/memory.js';
import { loadCatalog } from 'mcp-hub';

const catalogOf = (r: string) => () => loadCatalog(join(r, 'manifests', 'mcp-servers'));

let root = '';
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ''; });

/** 一個 root:一個好的 agent、一個工具不存在的 agent、一個壞掉的 JSON,catalog 只有一台 server。 */
function brokenRoot(): string {
  root = mkdtempSync(join(tmpdir(), 'agent-select-'));
  mkdirSync(join(root, 'manifests', 'agents'), { recursive: true });
  mkdirSync(join(root, 'manifests', 'mcp-servers'), { recursive: true });
  writeFileSync(join(root, 'manifests', 'agents', 'good.json'), JSON.stringify({ id: 'good', tools: ['up-echo'] }));
  writeFileSync(join(root, 'manifests', 'agents', 'bad-tool.json'), JSON.stringify({ id: 'bad-tool', tools: ['does-not-exist'] }));
  writeFileSync(join(root, 'manifests', 'agents', 'broken.json'), '{ not json');
  writeFileSync(join(root, 'manifests', 'mcp-servers', 'up.json'), JSON.stringify({
    id: 'up', transport: 'stdio', command: 'node', args: [], tools: { 'up-echo': 'echo' },
  }));
  return root;
}

const INLINE = { id: 'chat', flows: [], interactions: [], tools: [], capabilities: { filesystem: 'none' as const, shell: false } };

describe('agentIds', () => {
  it('不相干的 manifest 壞掉,選中的 agent 照樣建得起來', () => {
    const r = brokenRoot();
    const registry = buildRegistry({ manifestDir: join(r, 'manifests'), runtime: claudeCli, agentIds: ['good'], catalog: catalogOf(r) });
    expect(registry.ids()).toEqual(['good']);
    expect(registry.get('good').tools).toEqual(['up-echo']);
  });

  it('只用 inline 無工具 agent 時,連 catalog 都不讀', () => {
    const r = brokenRoot();
    const catalog = vi.fn(() => { throw new Error('should not load'); });
    const registry = buildRegistry({ manifestDir: join(r, 'manifests'), runtime: claudeCli, inline: [INLINE], agentIds: ['chat'], catalog });
    expect(registry.ids()).toEqual(['chat']);
    expect(catalog).not.toHaveBeenCalled();
  });

  it('createAgentEngine 建立時不驗 manifest;壞掉的 root 只在 check() 全量時才炸', () => {
    const r = brokenRoot();
    const scoped = createAgentEngine({ root: r, agents: [INLINE], agentIds: ['chat'], artifacts: createMemoryStore() });
    expect(scoped.check()).toEqual(['chat']);   // 只驗指定的
    // 不指定 agentIds 也建得起來(不再在建立時全量驗證);要全量 fail fast 就 check()
    const all = createAgentEngine({ root: r, agents: [INLINE], artifacts: createMemoryStore() });
    expect(() => all.check()).toThrow();
  });

  it('選中的 agent 自己壞掉仍然 fail loud', () => {
    const r = brokenRoot();
    expect(() => buildRegistry({ manifestDir: join(r, 'manifests'), runtime: claudeCli, agentIds: ['bad-tool'], catalog: catalogOf(r) }))
      .toThrow(/bad-tool.*does-not-exist/);
  });

  it('選中的 agent 找不到時,錯誤訊息附上其他 manifest 的載入錯誤', () => {
    const r = brokenRoot();
    expect(() => buildRegistry({ manifestDir: join(r, 'manifests'), runtime: claudeCli, agentIds: ['missing'] }))
      .toThrow(/沒有 agent "missing".*broken\.json/);
  });

  it('沒選到的 agent 取不到', () => {
    const r = brokenRoot();
    const registry = buildRegistry({ manifestDir: join(r, 'manifests'), runtime: claudeCli, agentIds: ['good'], catalog: catalogOf(r) });
    expect(() => registry.get('bad-tool')).toThrow(/沒有 agent "bad-tool"/);
  });

  it('同一個 id 同時在磁碟與 inline:只有選中它時才算錯', () => {
    const r = brokenRoot();
    const dupInline = { ...INLINE, id: 'good' };
    expect(() => buildRegistry({ manifestDir: join(r, 'manifests'), runtime: claudeCli, inline: [dupInline], agentIds: ['good'] }))
      .toThrow(/同時存在/);
  });
});

describe('validateManifests', () => {
  it('全量驗證會抓到任何一份壞掉的 manifest —— 放在測試 / CI,不在執行期', () => {
    const r = brokenRoot();
    expect(() => validateManifests({ root: r, runtime: claudeCli })).toThrow();
  });

  it('全部正確時回傳所有 agent id', () => {
    const r = brokenRoot();
    rmSync(join(r, 'manifests', 'agents', 'broken.json'));
    rmSync(join(r, 'manifests', 'agents', 'bad-tool.json'));
    expect(validateManifests({ root: r, runtime: claudeCli })).toEqual(['good']);
  });
});
