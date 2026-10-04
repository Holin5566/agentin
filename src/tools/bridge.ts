import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import type { AddressInfo } from 'node:net';
import { openGateway } from 'mcp-hub';
import type { ServerDecl, ToolDecl } from 'mcp-hub';
import type { FunctionTool } from './tool.js';

export interface ToolBridge {
  server: ServerDecl;
  routes: ToolDecl[];
  close(): Promise<void>;
}

/** Per-run loopback service. The stdio proxy never owns host implementations. */
export async function openToolBridge(tools: readonly FunctionTool[], agent: string, signal: AbortSignal): Promise<ToolBridge> {
  const runId = randomUUID();
  const serverId = `agentin-host-${runId}`;
  const token = randomBytes(32).toString('hex');
  const lifetime = new AbortController();
  const abort = () => lifetime.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const hub = await openGateway({
    tools: tools.map(tool => tool.id), log: () => {},
    catalog: { servers: [{ id: serverId, transport: 'in-memory' }], tools: tools.map(tool => ({ id: tool.id, serverId, toolName: tool.id })) },
    builtinTools: tools.map(tool => ({ name: tool.id, description: tool.description, inputSchema: tool.inputSchema, execute: (args, callSignal) => tool.execute(args, { agent, runId, signal: AbortSignal.any([callSignal, lifetime.signal]) }) })),
  });
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}` || req.headers.origin) { res.writeHead(403).end(); return; }
    const disconnected = new AbortController();
    res.on('close', () => { if (!res.writableEnded) disconnected.abort(); });
    try {
      lifetime.signal.throwIfAborted();
      let result: unknown;
      if (req.method === 'GET' && req.url === '/tools') result = await hub.list();
      else if (req.method === 'POST' && req.url === '/call') {
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 1024 * 1024) { res.writeHead(413).end(); return; }
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        result = await hub.callResult(body.id, body.args, AbortSignal.any([disconnected.signal, lifetime.signal]));
      } else { res.writeHead(404).end(); return; }
      lifetime.signal.throwIfAborted();
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch (error) {
      if (!res.destroyed) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: (error as Error).message }));
    }
  });
  server.requestTimeout = 10000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
  } catch (error) {
    lifetime.abort(); server.close(); server.closeAllConnections();
    signal.removeEventListener('abort', abort);
    await hub.close();
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    server: { id: serverId, transport: 'stdio', command: process.execPath, args: [join(dirname(require.resolve('../../package.json')), 'dist', 'tools', 'proxy.js')], env: { AGENTIN_BRIDGE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, AGENTIN_BRIDGE_TOKEN: token } },
    routes: tools.map(tool => ({ id: tool.id, serverId, toolName: tool.id })),
    close() {
      if (closing) return closing;
      lifetime.abort();
      signal.removeEventListener('abort', abort);
      server.close(); server.closeAllConnections();
      closing = hub.close();
      return closing;
    },
  };
}
