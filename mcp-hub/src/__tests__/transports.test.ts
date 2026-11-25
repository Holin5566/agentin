import { describe, it, expect } from 'vitest';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { interpolate, createExternalTransport } from '../upstream/transports.js';
import type { ServerDecl } from '../manifest/load.js';

const ENV = { TOKEN: 'sekrit', HOST: 'jira.example.com', EMPTY: '' };

describe('interpolate', () => {
  it('替換單一 ${VAR}', () => {
    expect(interpolate('--token=${TOKEN}', 'where', ENV)).toBe('--token=sekrit');
  });

  it('替換同一字串內的多個變數', () => {
    expect(interpolate('https://${HOST}/x?t=${TOKEN}', 'where', ENV)).toBe('https://jira.example.com/x?t=sekrit');
  });

  it('沒有引用時原樣回傳', () => {
    expect(interpolate('mcp-atlassian', 'where', ENV)).toBe('mcp-atlassian');
  });

  it('缺變數時 throw,訊息帶位置與變數名', () => {
    expect(() => interpolate('--token=${NOPE}', 'server "jira" args[1]', ENV))
      .toThrow(/server "jira" args\[1\].*NOPE/s);
  });

  it('空字串視同未設定 —— 代換成空值會讓 --token= 靜默變成沒有 token', () => {
    expect(() => interpolate('--token=${EMPTY}', 'where', ENV)).toThrow(/EMPTY/);
  });

  it('${VAR:-} 沒設或空字串時代入空值;有值就用值', () => {
    expect(interpolate('max=${NOPE:-}', 'where', ENV)).toBe('max=');
    expect(interpolate('max=${EMPTY:-}', 'where', ENV)).toBe('max=');
    expect(interpolate('t=${TOKEN:-}', 'where', ENV)).toBe('t=sekrit');
  });

  it('${VAR:-default} 沒設時代入 default', () => {
    expect(interpolate('max=${NOPE:-3}', 'where', ENV)).toBe('max=3');
    expect(interpolate('${HOST:-fallback.example.com}', 'where', ENV)).toBe('jira.example.com');
  });

  it('必填與選用混用時,必填缺值仍然 throw', () => {
    expect(() => interpolate('${NOPE:-x}/${ALSO_NOPE}', 'where', ENV)).toThrow(/ALSO_NOPE/);
    expect(interpolate('${HOST}/${NOPE:-}', 'where', ENV)).toBe('jira.example.com/');
  });

  it('不碰裸 $VAR(只認 ${VAR},避免誤傷含 $ 的字面值)', () => {
    expect(interpolate('cost is $TOKEN or $5', 'where', ENV)).toBe('cost is $TOKEN or $5');
  });
});

describe('createExternalTransport', () => {
  it('stdio:建出 StdioClientTransport', () => {
    const decl: ServerDecl = {
      id: 'jira', transport: 'stdio', command: 'uvx',
      args: ['mcp-atlassian', '--jira-token=${TOKEN}'],
    };
    expect(createExternalTransport(decl, ENV)).toBeInstanceOf(StdioClientTransport);
  });

  it('stdio:args 缺變數時 throw,並指名是哪台 server 的第幾個參數', () => {
    const decl: ServerDecl = {
      id: 'gitlab', transport: 'stdio', command: 'npx', args: ['-y', '${MISSING}'],
    };
    expect(() => createExternalTransport(decl, ENV)).toThrow(/server "gitlab" args\[1\].*MISSING/s);
  });

  it('stdio:env 缺變數時 throw,並指名是哪個 key', () => {
    const decl: ServerDecl = {
      id: 'gitlab', transport: 'stdio', command: 'npx',
      env: { GITLAB_PERSONAL_ACCESS_TOKEN: '${MISSING}' },
    };
    expect(() => createExternalTransport(decl, ENV))
      .toThrow(/server "gitlab" env\.GITLAB_PERSONAL_ACCESS_TOKEN.*MISSING/s);
  });

  it('sse:建出 SSEClientTransport', () => {
    const decl: ServerDecl = { id: 'playwright', transport: 'sse', url: 'http://localhost:3100/sse' };
    expect(createExternalTransport(decl, ENV)).toBeInstanceOf(SSEClientTransport);
  });

  it('streamable-http:建出 StreamableHTTPClientTransport', () => {
    const decl: ServerDecl = { id: 'remote', transport: 'streamable-http', url: 'https://x.example.com/mcp' };
    expect(createExternalTransport(decl, ENV)).toBeInstanceOf(StreamableHTTPClientTransport);
  });

  it('url 也做插值', () => {
    const decl: ServerDecl = { id: 'remote', transport: 'sse', url: 'https://${HOST}/sse' };
    expect(createExternalTransport(decl, ENV)).toBeInstanceOf(SSEClientTransport);
  });

  it('url 缺變數時 throw', () => {
    const decl: ServerDecl = { id: 'remote', transport: 'sse', url: 'https://${MISSING}/sse' };
    expect(() => createExternalTransport(decl, ENV)).toThrow(/server "remote" url.*MISSING/s);
  });

  it('沒有 ${VAR} 的宣告不讀環境,環境全空也能建', () => {
    const decl: ServerDecl = { id: 'x', transport: 'stdio', command: 'echo', args: ['hi'] };
    expect(createExternalTransport(decl, {})).toBeInstanceOf(StdioClientTransport);
  });
});

describe('connectTimeoutMs', () => {
  it('stdio 上游起來了卻一直不回 initialize:依 connectTimeoutMs 放棄,不等 SDK 預設的 60 秒', async () => {
    const { createClientRegistry } = await import('../upstream/registry.js');
    const reg = createClientRegistry([{
      id: 'mute', transport: 'stdio', command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'], connectTimeoutMs: 300,
    }]);
    const t0 = Date.now();
    await expect(reg.get('mute')).rejects.toThrow(/timed out/i);
    expect(Date.now() - t0).toBeLessThan(3_000);
    await reg.closeAll();
  }, 10_000);
});
