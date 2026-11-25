/**
 * hub 自己持有上游的 OAuth 憑證(Figma remote MCP 等)。互動登入要真人按 Allow,這裡驗
 * manifest、儲存、gateway 模式的錯誤語意與 transport 接線。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadCatalog } from '../manifest/load.js';
import { FileOAuthProvider, OAuthLoginRequired, withFileLock } from '../upstream/oauth.js';

/** 跨程序測試要真的另起程序,載入建置好的 dist(`npm test` 的 pretest 會先 build)。 */
const PROVIDER_DIST = join(__dirname, '..', '..', 'dist', 'upstream', 'oauth.js');
import { createExternalTransport } from '../upstream/transports.js';

let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });

function catalogWith(server: object) {
  dir = mkdtempSync(join(tmpdir(), 'oauth-'));
  writeFileSync(join(dir, 's.json'), JSON.stringify(server));
  return () => loadCatalog(dir);
}

describe('manifest auth', () => {
  const base = { id: 'fig', transport: 'streamable-http', url: 'https://example.com/mcp', tools: { 'fig-a': 'a' } };

  it('store 省略 = server id;scope 照填', () => {
    expect(catalogWith({ ...base, auth: { type: 'oauth', scope: 'mcp:connect' } })().servers[0].auth)
      .toEqual({ type: 'oauth', store: 'fig', scope: 'mcp:connect' });
  });

  it('type 不是 oauth / store 含路徑字元 / 用在 stdio → 載入時就報錯', () => {
    expect(catalogWith({ ...base, auth: { type: 'basic' } })).toThrow(/auth 必須是/);
    expect(catalogWith({ ...base, auth: { type: 'oauth', store: '../x' } })).toThrow(/auth.store/);
    expect(catalogWith({ id: 's', transport: 'stdio', command: 'x', auth: { type: 'oauth' }, tools: {} })).toThrow(/auth 只支援/);
  });

});

describe('FileOAuthProvider', () => {
  const decl = { type: 'oauth' as const, store: 'fig', scope: 'mcp:connect' };
  const env = () => { dir = mkdtempSync(join(tmpdir(), 'oauth-')); return { MCP_HUB_OAUTH_DIR: dir }; };

  it('token / client / verifier / state 存在同一個檔,權限 600', () => {
    const e = env();
    const p = new FileOAuthProvider('fig', decl, 'login', () => {}, e);
    p.saveClientInformation({ client_id: 'c1' } as any);
    p.saveTokens({ access_token: 'a', token_type: 'Bearer', refresh_token: 'r' });
    p.saveCodeVerifier('v');
    const state = p.state();
    const again = new FileOAuthProvider('fig', decl, 'gateway', undefined, e);
    expect(again.clientInformation()).toEqual({ client_id: 'c1' });
    expect(again.tokens()?.refresh_token).toBe('r');
    expect(again.codeVerifier()).toBe('v');
    expect(again.expectedState()).toBe(state);
    expect(statSync(p.file).mode & 0o777).toBe(0o600);
  });

  it('state 每次都新產生(Figma 要求 state,SDK 當選配 —— 一定要實作)', () => {
    const p = new FileOAuthProvider('fig', decl, 'login', () => {}, env());
    expect(p.state()).not.toBe(p.state());
    expect(p.state()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('client metadata:redirect、PKCE 公開 client、scope', () => {
    const p = new FileOAuthProvider('fig', decl, 'login', () => {}, { ...env(), MCP_HUB_OAUTH_REDIRECT: 'http://localhost:9999/cb' });
    expect(p.clientMetadata).toMatchObject({
      redirect_uris: ['http://localhost:9999/cb'], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], scope: 'mcp:connect',
    });
  });

  it('gateway 模式要重新授權時丟 OAuthLoginRequired,訊息寫明怎麼修 —— 不開瀏覽器', async () => {
    const p = new FileOAuthProvider('figma-remote', decl, 'gateway', undefined, env());
    const err = await p.redirectToAuthorization(new URL('https://example.com/auth')).catch((e) => e);
    expect(err).toBeInstanceOf(OAuthLoginRequired);
    expect(err.message).toContain('auth-login -- figma-remote');
  });

  it('login 模式把授權網址交給呼叫端', async () => {
    let got = '';
    const p = new FileOAuthProvider('fig', decl, 'login', (u) => { got = u.toString(); }, env());
    await p.redirectToAuthorization(new URL('https://example.com/auth?x=1'));
    expect(got).toBe('https://example.com/auth?x=1');
  });

  it('refresh token 輪替撞車:別的 gateway 已經換到新 tokens,輸家的作廢不能把它刪掉', () => {
    const e = env();
    const loser = new FileOAuthProvider('fig', decl, 'gateway', undefined, e);
    const winner = new FileOAuthProvider('fig', decl, 'gateway', undefined, e);
    loser.saveTokens({ access_token: 'old', token_type: 'Bearer', refresh_token: 'r1' });
    expect(loser.tokens()?.refresh_token).toBe('r1');
    expect(winner.tokens()?.refresh_token).toBe('r1');
    // 兩個都拿 r1 去換;winner 先換到並存檔,loser 收到 invalid_grant,SDK 叫它作廢
    winner.saveTokens({ access_token: 'new', token_type: 'Bearer', refresh_token: 'r2' });
    loser.invalidateCredentials('tokens');
    expect(new FileOAuthProvider('fig', decl, 'gateway', undefined, e).tokens()?.refresh_token).toBe('r2');
  });

  it('檔案壞掉:先備份再視為未授權,不在下次寫入時把 client 註冊一起蓋掉', () => {
    const e = env();
    const p = new FileOAuthProvider('fig', decl, 'gateway', undefined, e);
    writeFileSync(p.file, '{"client":{"client_id":"c1"},"tok');
    const errWrite = process.stderr.write;
    process.stderr.write = (() => true) as any;
    try { expect(p.tokens()).toBeUndefined(); } finally { process.stderr.write = errWrite; }
    const backups = readdirSync(dir).filter((f) => f.startsWith('fig.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dir, backups[0]!), 'utf8')).toContain('"client_id":"c1"');
  });

  it.skipIf(!existsSync(PROVIDER_DIST))('兩個 gateway 程序同時寫不同欄位:鎖住讀改寫,誰的更新都不會掉', async () => {
    const e = env();
    const run = (field: 'client' | 'tokens') => new Promise<number | null>((ok) => {
      const src = `const { FileOAuthProvider } = await import(${JSON.stringify(PROVIDER_DIST)});
        const p = new FileOAuthProvider('fig', { type: 'oauth', store: 'fig' }, 'gateway', undefined, { MCP_HUB_OAUTH_DIR: ${JSON.stringify(dir)} });
        for (let i = 0; i < 300; i++) ${field === 'client'
          ? `p.saveClientInformation({ client_id: 'c' + i });`
          : `p.saveTokens({ access_token: 'a' + i, token_type: 'Bearer' });`}`;
      spawn(process.execPath, ['--input-type=module', '-e', src], { stdio: 'inherit' }).on('exit', ok);
    });
    expect(await Promise.all([run('client'), run('tokens')])).toEqual([0, 0]);
    const p = new FileOAuthProvider('fig', decl, 'gateway', undefined, e);
    expect(p.clientInformation()).toEqual({ client_id: 'c299' });
    expect(p.tokens()?.access_token).toBe('a299');
    expect(readdirSync(dir).filter((f) => f.endsWith('.lock'))).toEqual([]);
  }, 30_000);

  it('殘留的鎖(持有者當掉)逾期後會被清掉,不會永遠卡住', () => {
    const lock = join(env().MCP_HUB_OAUTH_DIR, 'x.lock');
    writeFileSync(lock, '');
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(lock, old, old);
    expect(withFileLock(lock, () => 'ran')).toBe('ran');
    expect(existsSync(lock)).toBe(false);
  });

  it('release 只刪自己的鎖:期間被當殘留搶走(內容已變)就不刪別人的新鎖', () => {
    // TOCTOU 防線:若我們的鎖在持有期間被另一個程序當成殘留搶走並建了新鎖
    // (內容 token 已不同),release 不能把別人的新鎖刪掉。
    const lock = join(env().MCP_HUB_OAUTH_DIR, 'z.lock');
    withFileLock(lock, () => { writeFileSync(lock, 'other-owner'); });
    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(lock, 'utf8')).toBe('other-owner');
  });

  it('write 清掉別的程序殘留的 .tmp,但保留 .corrupt 備份', () => {
    const e = env();
    const p = new FileOAuthProvider('fig', decl, 'login', () => {}, e);
    const orphanTmp = join(e.MCP_HUB_OAUTH_DIR, 'fig.json.99999.tmp');
    const corrupt = join(e.MCP_HUB_OAUTH_DIR, 'fig.json.corrupt-123');
    writeFileSync(orphanTmp, 'junk');
    writeFileSync(corrupt, 'junk');
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(orphanTmp, old, old);
    p.state(); // 觸發 write() → pruneStaleTmp
    expect(existsSync(orphanTmp)).toBe(false); // 殘留 .tmp 被清
    expect(existsSync(corrupt)).toBe(true);    // .corrupt 備份保留(給人工救回)
  });

  it('invalidateCredentials(tokens) 只清 token,留下 client', () => {
    const p = new FileOAuthProvider('fig', decl, 'login', () => {}, env());
    p.saveClientInformation({ client_id: 'c1' } as any);
    p.saveTokens({ access_token: 'a', token_type: 'Bearer' });
    p.invalidateCredentials('tokens');
    expect(p.tokens()).toBeUndefined();
    expect(p.clientInformation()).toEqual({ client_id: 'c1' });
  });
});

describe('transport 接線', () => {
  it('有宣告 auth 的 streamable-http 會帶 gateway 模式的 provider', () => {
    const t = createExternalTransport({ id: 'fig', transport: 'streamable-http', url: 'https://example.com/mcp', auth: { type: 'oauth', store: 'fig' } }, {});
    expect(t).toBeInstanceOf(StreamableHTTPClientTransport);
    const provider = (t as any)._authProvider;
    expect(provider).toBeInstanceOf(FileOAuthProvider);
    expect(provider.mode).toBe('gateway');
  });

  it('沒宣告 auth → 不帶 provider(行為跟以前一樣)', () => {
    const t = createExternalTransport({ id: 'x', transport: 'streamable-http', url: 'https://example.com/mcp' }, {});
    expect((t as any)._authProvider).toBeUndefined();
  });
});
