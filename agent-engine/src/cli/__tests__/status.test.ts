import { describe, expect, it } from 'vitest';
import type { Catalog } from 'mcp-hub';
import { buildStatus, renderStatus } from '../status.js';

const catalog: Catalog = {
  servers: [
    { id: 'jira', transport: 'stdio', command: 'x' },
    { id: 'remote', transport: 'streamable-http', url: 'https://x', auth: { type: 'oauth', store: 'remote' } },
  ],
  tools: [
    { id: 'jira-get', serverId: 'jira', toolName: 'get_issue' },
    { id: 'remote-who', serverId: 'remote', toolName: 'whoami' },
  ] as Catalog['tools'],
};
const agents = [
  { id: 'analyze', flows: [], interactions: [], tools: ['jira-get'], capabilities: { filesystem: 'read-only' as const } },
  { id: 'broken', flows: [], interactions: [], tools: ['jira-get', 'nope'] },
];

describe('buildStatus', () => {
  it('每個工具標出哪些 agent 在用;沒人用的列進 unused', () => {
    const r = buildStatus(catalog, agents);
    expect(r.servers[0].tools).toEqual([{ id: 'jira-get', upstream: 'get_issue', usedBy: ['analyze', 'broken'] }]);
    expect(r.servers[1]).toMatchObject({ auth: 'oauth', tools: [{ id: 'remote-who', usedBy: [] }] });
    expect(r.unused).toEqual(['remote-who']);
  });

  it('agent 引用了沒宣告的工具 → unknownTools', () => {
    expect(buildStatus(catalog, agents).agents.find((a) => a.id === 'broken')!.unknownTools).toEqual(['nope']);
  });

  it('帶撥號結果時合併進 server', () => {
    const r = buildStatus(catalog, agents, [], [
      { id: 'jira', transport: 'stdio', ok: true, upstreamTools: 1, declared: ['get_issue'], missing: [] },
      { id: 'remote', transport: 'streamable-http', ok: false, declared: ['whoami'], missing: [], error: '尚未授權' },
    ]);
    expect(r.servers[0].dial).toEqual({ ok: true, upstreamTools: 1, missing: [] });
    expect(r.servers[1].dial).toMatchObject({ ok: false, error: '尚未授權' });
  });
});

describe('renderStatus', () => {
  it('人看得懂:用途、未使用、錯誤都寫出來', () => {
    const text = renderStatus(buildStatus(catalog, agents, ['agents/bad.json: 不是 JSON']));
    expect(text).toContain('jira-get → get_issue  用於:analyze, broken');
    expect(text).toContain('remote-who → whoami  (沒有 agent 使用)');
    expect(text).toContain('⚠️ 未宣告的工具:nope');
    expect(text).toContain('agents/bad.json: 不是 JSON');
  });
});
