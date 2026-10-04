/**
 * 給 core / gateway 測試共用的接線。不是測試檔(沒有 describe),放這裡是為了讓
 * 兩邊用同一組 fixture —— 各抄一份遲早會漂。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createBuiltinServer } from '../builtin/server.js';
import type { BuiltinTool } from '../types.js';
import type { ClientRegistry } from '../upstream/registry.js';
import type { ToolDecl } from '../manifest/load.js';

/** 真的接一台 builtin server,不 mock 協議層 —— in-memory 那一跳是這個設計的賭注。 */
export async function clientFor(tools: BuiltinTool[]): Promise<Client> {
  const [c, s] = InMemoryTransport.createLinkedPair();
  await createBuiltinServer(tools).connect(s);
  const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
  await client.connect(c);
  return client;
}

/** `dropped` 讓測試看得到 core 丟掉了哪個 server 的哪個實例。 */
export function registryOf(
  client: Client,
  dropped: Array<{ serverId: string; client: Client }> = [],
): ClientRegistry {
  return {
    async get() { return client; },
    drop(serverId, c) { dropped.push({ serverId, client: c }); },
    async closeAll() {},
  };
}

export const echo: BuiltinTool = {
  name: 'repo_search',
  description: 'test double',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  async execute(args) { return `echo:${args.query}`; },
};

/** 測試用路由表。真實的那份由 loadCatalog() 從 manifests 讀,見 manifest.test.ts。 */
export const ROUTES: ToolDecl[] = [
  { id: 'repo-search', serverId: 'guardian', toolName: 'repo_search' },
];
