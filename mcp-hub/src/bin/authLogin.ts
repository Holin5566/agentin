#!/usr/bin/env node
/**
 * `mcp-hub auth-login <server id>`:對宣告了 `auth: { type: "oauth" }` 的上游做一次互動登入。
 *
 *   MCP_HUB_ROOT=<專案根> npm --prefix mcp-hub run auth-login -- atlassian-remote
 *
 * 1. 在本機開臨時網頁伺服器當 redirect 目標(預設 http://localhost:7777/callback)
 * 2. 連上游 → 401 → SDK 自動做資源探索、動態註冊 client、PKCE
 * 3. 開瀏覽器到授權頁,人按 Allow → 導回本機帶授權碼
 * 4. 比對 state → finishAuth(code) 換到 token → 存到 token 檔(chmod 600)
 * 5. 重連一次、列出工具,確認整條路通
 *
 * **需要真人在瀏覽器點一次 Allow。** 換機要重跑(token 檔不要跨機複製,見 OAuth 筆記)。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { loadCatalog } from '../manifest/load.js';
import { FileOAuthProvider, redirectUrl } from '../upstream/oauth.js';
import { interpolate } from '../upstream/transports.js';

const LOGIN_TIMEOUT_MS = 5 * 60_000;

/** 等瀏覽器導回 redirect URL,回傳 { code, state }。 */
function waitForCallback(redirect: URL): Promise<{ code: string; state: string | null }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', redirect);
      if (url.pathname !== redirect.pathname) { res.writeHead(404).end(); return; }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      // error 來自網址,原樣塞進 HTML 就是一個 reflected XSS(雖然只在 localhost)。
      const safe = (error ?? '沒有 code').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(code ? '<p>授權完成,可以關閉這個分頁。</p>' : `<p>授權失敗:${safe}</p>`);
      server.close();
      clearTimeout(timer);
      if (code) resolve({ code, state: url.searchParams.get('state') });
      else reject(new Error(`授權失敗:${error ?? '回呼沒有 code'}`));
    });
    const timer = setTimeout(() => { server.close(); reject(new Error('等待授權逾時(5 分鐘)')); }, LOGIN_TIMEOUT_MS);
    server.on('error', (e) => { clearTimeout(timer); reject(new Error(`無法在 ${redirect.host} 開 redirect 伺服器:${e.message}`)); });
    server.listen(Number(redirect.port || 80), redirect.hostname);
  });
}

async function main(): Promise<void> {
  const serverId = process.argv.slice(2).find((a) => !a.startsWith('-'));
  if (!serverId) throw new Error('用法:mcp-hub auth-login <server id>');
  const decl = loadCatalog().servers.find((s) => s.id === serverId);
  if (!decl) throw new Error(`manifest 裡沒有 server "${serverId}"`);
  if (!decl.auth || !decl.url || decl.transport !== 'streamable-http') {
    throw new Error(`server "${serverId}" 沒有宣告 OAuth(auth: { type: "oauth" }),或不是 streamable-http`);
  }
  const url = new URL(interpolate(decl.url, `server "${serverId}" url`));
  const redirect = new URL(redirectUrl());

  let callback: Promise<{ code: string; state: string | null }> | undefined;
  const provider = new FileOAuthProvider(serverId, decl.auth, 'login', (authUrl) => {
    callback = waitForCallback(redirect);
    console.log(`\n請在瀏覽器完成授權(會自動開啟;沒開的話手動貼上):\n${authUrl.toString()}\n`);
    spawn('open', [authUrl.toString()], { stdio: 'ignore', detached: true }).unref();
  });

  const connect = async () => {
    const client = new Client({ name: 'mcp-hub-auth-login', version: '0.1.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
    await client.connect(transport);
    return { client, transport };
  };

  try {
    const { client } = await connect();
    console.log(`✓ ${serverId} 已經有有效的授權(token 檔:${provider.file})`);
    console.log(`  工具:${(await client.listTools()).tools.map((t) => t.name).join(', ')}`);
    await client.close();
    return;
  } catch (e) {
    if (!(e instanceof UnauthorizedError) || !callback) throw e;
  }

  const { code, state } = await callback;
  if (state !== provider.expectedState()) throw new Error('授權回呼的 state 對不上,可能不是這次登入發起的,已中止');
  const finisher = new StreamableHTTPClientTransport(url, { authProvider: provider });
  await finisher.finishAuth(code);

  const { client } = await connect();
  const tools = (await client.listTools()).tools.map((t) => t.name);
  await client.close();
  console.log(`✓ ${serverId} 授權完成,token 存在 ${provider.file}`);
  console.log(`  工具(${tools.length}):${tools.join(', ')}`);
}

main().catch((e) => {
  console.error(`✗ ${e?.message ?? e}`);
  process.exit(1);
});
