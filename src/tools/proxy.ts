import { serveBuiltinStdio } from 'mcp-hub';
import type { BuiltinTool, InputSchema } from 'mcp-hub';

async function main(): Promise<void> {
  const base = process.env.AGENTIN_BRIDGE_URL;
  const token = process.env.AGENTIN_BRIDGE_TOKEN;
  if (!base || !token) throw new Error('missing host bridge configuration');
  const request = async (path: string, body?: unknown, signal?: AbortSignal) => {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal,
    });
    if (!response.ok) throw new Error(`host bridge failed (${response.status}): ${await response.text()}`);
    return response.json();
  };
  const listings = await request('/tools') as { id: string; description?: string; inputSchema: InputSchema }[];
  const tools: BuiltinTool[] = listings.map(tool => ({ name: tool.id, description: tool.description ?? '', inputSchema: tool.inputSchema, execute: (args, signal) => request('/call', { id: tool.id, args }, signal) }));
  await serveBuiltinStdio(tools, { name: 'agentin-host-proxy' });
}
main().catch(error => { process.stderr.write(`${(error as Error).message}\n`); process.exitCode = 1; });
