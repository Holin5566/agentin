#!/usr/bin/env node
/**
 * stdio MCP 入口：解析範圍、組裝核心與 gateway，並在 SIGINT / SIGTERM 時清理連線。
 * 每個程序持有自己的連線池，可連接 builtin 與外部 MCP server。
 *
 * node dist/bin/entry.js --tools repo-search,jira-get_issue
 * node dist/bin/entry.js --all-tools  # 開發用
 *
 * 允許清單由呼叫端算好傳進來(engine 從 agent manifest 算)—— hub 不讀 agent manifest。
 */
import { randomUUID } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createClientRegistry } from '../upstream/registry.js';
import { createToolCore } from '../core.js';
import { createGateway } from '../gateway.js';
import { parseArgs, resolveScope } from './args.js';
import { installShutdown } from '../shared/shutdown.js';

async function main(): Promise<void> {
  const runId = process.env.AGENT_ENGINE_RUN_ID ?? randomUUID().slice(0, 8);
  const { catalog, allow, label } = resolveScope(parseArgs(process.argv.slice(2)));

  const clients = createClientRegistry(catalog.servers);
  const core = createToolCore({
    routes: catalog.tools, clients, runId,
    ...(allow ? { allow } : {}),
  });
  const gateway = createGateway({ core });

  // stdin EOF = 呼叫端離開,跟上游斷線不同(那個由 registry 處理)。上游連線會撐住 event loop,
  // 所以 claude 被 SIGKILL / 崩潰、只剩管線斷掉時也要收(見 installShutdown)。
  installShutdown(`gateway ${runId}`, () => clients.closeAll());

  await gateway.connect(new StdioServerTransport());
  process.stderr.write(`[gateway ${runId}] ready — ${label}\n`);
}

main().catch((e) => {
  process.stderr.write(`[gateway] fatal: ${e?.message ?? e}\n`);
  process.exit(1);
});
