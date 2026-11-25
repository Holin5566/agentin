#!/usr/bin/env node
/**
 * `npm --prefix agent-engine run status [-- --dial] [-- --json]`
 *
 * 一次看清楚:hub 宣告了哪些上游、每台開放哪些工具、哪些 agent 在用、哪裡對不上。
 *
 * **放在 engine,不放在 mcp-hub** —— 「誰在用」要讀 agent manifest,而 hub 刻意不知道
 * agent 是什麼(允許清單由 engine 算好再交給它)。
 *
 * 預設只讀宣告(不連線、不需要任何環境變數);`--dial` 才實際撥號(同 `mcp-hub check`,
 * stdio 上游的 `${VAR}` 要先載入環境)。專案根:`MCP_HUB_ROOT` ?? `AGENT_ENGINE_ROOT` ?? cwd。
 */
import { join, resolve } from 'node:path';
import { checkServers, loadCatalog, type Catalog, type ServerCheck } from 'mcp-hub';
import { loadManifestsLenient, type AgentManifest } from '../agents/manifest.js';

export interface StatusReport {
  servers: Array<{
    id: string; transport: string; auth?: string;
    tools: Array<{ id: string; upstream: string; usedBy: string[] }>;
    dial?: { ok: boolean; upstreamTools?: number; missing: string[]; error?: string };
  }>;
  agents: Array<{ id: string; tools: string[]; unknownTools: string[]; capabilities?: string }>;
  /** 宣告了但沒有任何 agent 用的工具 id。 */
  unused: string[];
  manifestErrors: string[];
}

/** 純函式:宣告(+ 選配的撥號結果)→ 報表。 */
export function buildStatus(catalog: Catalog, agents: AgentManifest[], manifestErrors: string[] = [], checks?: ServerCheck[]): StatusReport {
  const known = new Set(catalog.tools.map((t) => t.id));
  const usedBy = new Map<string, string[]>();
  for (const a of agents) for (const t of a.tools ?? []) usedBy.set(t, [...(usedBy.get(t) ?? []), a.id]);

  const servers = catalog.servers.map((s) => {
    const check = checks?.find((c) => c.id === s.id);
    return {
      id: s.id, transport: s.transport, ...(s.auth ? { auth: s.auth.type } : {}),
      tools: catalog.tools.filter((t) => t.serverId === s.id).map((t) => ({ id: t.id, upstream: t.toolName, usedBy: usedBy.get(t.id) ?? [] })),
      ...(check ? { dial: { ok: check.ok, upstreamTools: check.upstreamTools, missing: check.missing, ...(check.error ? { error: check.error } : {}) } } : {}),
    };
  });
  return {
    servers,
    agents: agents.map((a) => ({
      id: a.id, tools: a.tools ?? [], unknownTools: (a.tools ?? []).filter((t) => !known.has(t)),
      ...(a.capabilities && Object.keys(a.capabilities).length ? { capabilities: JSON.stringify(a.capabilities) } : {}),
    })),
    unused: catalog.tools.filter((t) => !usedBy.has(t.id)).map((t) => t.id),
    manifestErrors,
  };
}

export function renderStatus(r: StatusReport): string {
  const out: string[] = ['## 上游(manifests/mcp-servers)'];
  if (!r.servers.length) out.push('(沒有宣告任何上游)');
  for (const s of r.servers) {
    const dial = s.dial
      ? (s.dial.ok ? ` · ✓ 連得上(上游 ${s.dial.upstreamTools} 個工具${s.dial.missing.length ? `,⚠️ 上游沒有:${s.dial.missing.join(', ')}` : ''})` : ` · ✗ ${s.dial.error ?? '連不上'}`)
      : '';
    out.push(`- ${s.id} [${s.transport}${s.auth ? ` · ${s.auth}` : ''}]${dial}`);
    for (const t of s.tools) out.push(`    ${t.id} → ${t.upstream}  ${t.usedBy.length ? `用於:${t.usedBy.join(', ')}` : '(沒有 agent 使用)'}`);
  }
  out.push('', '## agent(manifests/agents)');
  for (const a of r.agents) {
    const tools = a.tools.length ? a.tools.join(', ') : '(無 hub 工具)';
    out.push(`- ${a.id}:${tools}${a.capabilities ? `  · ${a.capabilities}` : ''}${a.unknownTools.length ? `  ⚠️ 未宣告的工具:${a.unknownTools.join(', ')}` : ''}`);
  }
  if (r.unused.length) out.push('', `沒有 agent 使用的工具:${r.unused.join(', ')}`);
  if (r.manifestErrors.length) out.push('', '## ⚠️ 載入失敗的 manifest', ...r.manifestErrors.map((e) => `- ${e}`));
  return out.join('\n');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const root = resolve(process.env.MCP_HUB_ROOT ?? process.env.AGENT_ENGINE_ROOT ?? process.cwd());
  const catalog = loadCatalog(join(root, 'manifests', 'mcp-servers'));
  const { manifests, errors } = loadManifestsLenient(join(root, 'manifests'));
  const checks = argv.includes('--dial') ? await checkServers({}) : undefined;
  const report = buildStatus(catalog, manifests, errors, checks);
  console.log(argv.includes('--json') ? JSON.stringify(report, null, 2) : `專案根:${root}\n\n${renderStatus(report)}`);
  const broken = report.manifestErrors.length || report.agents.some((a) => a.unknownTools.length)
    || report.servers.some((s) => s.dial && (!s.dial.ok || s.dial.missing.length));
  process.exitCode = broken ? 1 : 0;
}

if (require.main === module) {
  main().catch((e) => { console.error(`✗ ${e?.message ?? e}`); process.exit(1); });
}
