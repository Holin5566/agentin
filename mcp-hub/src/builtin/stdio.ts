/**
 * 把宿主自己的工具做成一台 stdio MCP server。
 *
 * **為什麼需要這個:** 走 `claude -p` 的 take,gateway 是另一個程序,收不到宿主的
 * JS 物件(`openGateway({ builtinTools })` 只在 in-process 有效)。宿主的工具要讓
 * 那條路用到,就得是一台真的上游 server,在 `manifests/mcp-servers/` 宣告成
 * `transport: "stdio"`。
 *
 * 宿主只要寫一支入口:
 *
 *   import { serveBuiltinStdio } from 'mcp-hub';
 *   serveBuiltinStdio([myTool], { name: 'guardian-tools' });
 *
 * 收尾(訊號、stdin EOF、寬限期)跟 gateway 共用 `shared/shutdown.ts` 的 `installShutdown`。
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { BuiltinTool } from '../types.js';
import { createBuiltinServer } from './server.js';
import { installShutdown } from '../shared/shutdown.js';

export interface ServeBuiltinStdioOpts {
  /** 寫在 stderr 的 log 前綴,方便在 gateway 的 log 裡認出是哪一台。 */
  name?: string;
  /** 收尾時要做的事(例如關掉 HTTP keep-alive)。失敗不擋住退出。 */
  onShutdown?: () => Promise<void> | void;
}

export interface BuiltinStdioServer {
  /** 主動收尾。測試與宿主想提早結束時用。 */
  close(): Promise<void>;
}

export async function serveBuiltinStdio(
  tools: BuiltinTool[],
  opts: ServeBuiltinStdioOpts = {},
): Promise<BuiltinStdioServer> {
  const name = opts.name ?? 'builtin';
  const server = createBuiltinServer(tools);

  const shutdown = installShutdown(name, async () => {
    try { await opts.onShutdown?.(); } catch { /* 收尾失敗不擋退出 */ }
    await server.close();
  });

  await server.connect(new StdioServerTransport());
  process.stderr.write(`[${name}] ready — ${tools.map((t) => t.name).join(', ') || '(no tools)'}\n`);

  return { close: () => shutdown('close()') };
}
