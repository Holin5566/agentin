import { describe, expect, it } from 'vitest';
import { claudeCli, createClaudeCli, toolsFor } from '../runtimes/claudeCli.js';
import { codexCli, sandboxFor } from '../runtimes/codexCli.js';
import { EngineError } from '../types.js';

/**
 * adapter 是純函式,所以「意圖翻成旗標」這件事測得出來。
 *
 * 這組測試真正在驗的是:**同一份 `capabilities` 在兩個 runtime 上翻成完全不同的
 * 旗標,而 manifest 不必知道任何一邊的詞彙。** 這是 manifest 寫意圖不寫旗標的理由。
 */

describe('claude —— 意圖翻成工具名單', () => {
  it('沒宣告 capabilities = 不限制,不下 --tools', () => {
    expect(toolsFor(undefined)).toBeUndefined();
    expect(toolsFor({})).toBeUndefined();
    expect(claudeCli.command({ prompt: 'x' }).args).not.toContain('--tools');
  });

  it('read-only 只給讀的工具', () => {
    expect(toolsFor({ filesystem: 'read-only' })).toEqual(['Read', 'Grep', 'Glob']);
  });

  it('workspace-write 加上寫的工具', () => {
    expect(toolsFor({ filesystem: 'workspace-write' })).toEqual(['Read', 'Grep', 'Glob', 'Write', 'Edit']);
  });

  it('shell 要明寫才有 Bash', () => {
    expect(toolsFor({ filesystem: 'read-only' })).not.toContain('Bash');
    expect(toolsFor({ filesystem: 'read-only', shell: true })).toContain('Bash');
  });

  it('filesystem: none = 全關,而不是不限制', () => {
    // 空陣列與 undefined 意義相反:前者是 `--tools ""`(什麼都不給),
    // 後者是根本不下旗標(全開)。這條分不清楚就會把沙箱開成全開。
    expect(toolsFor({ filesystem: 'none' })).toEqual([]);
    expect(claudeCli.command({ prompt: 'x', capabilities: { filesystem: 'none' } }).args)
      .toEqual(expect.arrayContaining(['--tools', '']));
  });

  it('宣告了就是完整聲明 —— 沒寫到的不給', () => {
    // 只寫 shell:true 不代表「其餘照舊」,代表「只有 shell」。
    expect(toolsFor({ shell: true })).toEqual(['Bash']);
  });

  it('AS-3289 的情境:產 .feature 的 take 不能有寫檔與搜尋能力', () => {
    const tools = toolsFor({ filesystem: 'none', shell: false })!;
    expect(tools).toEqual([]);
    for (const banned of ['Write', 'Edit', 'Bash', 'Grep']) expect(tools).not.toContain(banned);
  });

  it('有 gateway 時帶上設定檔', () => {
    expect(claudeCli.command({ prompt: 'x', mcpConfigPath: '/tmp/m.json' }).args)
      .toEqual(expect.arrayContaining(['--strict-mcp-config', '--mcp-config', '/tmp/m.json']));
  });

  it('沒有 gateway 時仍然帶 --strict-mcp-config', () => {
    // 實測發現的漏洞:少了它,宣告 tools: [] 的 agent 會繼承使用者全域的每一台
    // MCP server(Gmail / Drive / Figma 都在),而 --tools 對 mcp__* 無效擋不住。
    // 「沒有工具」的 agent 能寄信,是這包程式最不該出現的失敗。
    const args = claudeCli.command({ prompt: 'x' }).args;
    expect(args).toContain('--strict-mcp-config');
    expect(args).not.toContain('--mcp-config');
  });

  it('宿主指定的額外 MCP server 與 gateway 並存,且仍帶 --strict-mcp-config', () => {
    const runtime = createClaudeCli({ mcpServers: { 'figma-remote': { type: 'http', url: 'https://mcp.figma.com/mcp' } } });
    const args = runtime.command({ prompt: 'x', mcpConfigPath: '/tmp/m.json' }).args;
    expect(args).toContain('--strict-mcp-config');
    const configs = args.flatMap((arg, i) => arg === '--mcp-config' ? [args[i + 1]] : []);
    expect(configs).toEqual(['/tmp/m.json', JSON.stringify({ mcpServers: { 'figma-remote': { type: 'http', url: 'https://mcp.figma.com/mcp' } } })]);
    expect(runtime.command({ prompt: 'x' }).args.filter(arg => arg === '--mcp-config')).toHaveLength(1);
  });

  it('prompt 原樣走 stdin,不進 argv —— 開頭是 `-` 的 prompt 不會被當成 option', () => {
    const prompt = '- a "quoted" $VAR; rm -rf /';
    const cmd = claudeCli.command({ prompt });
    expect(cmd.stdin).toBe(prompt);
    expect(cmd.args[0]).toBe('-p');
    expect(cmd.args).not.toContain(prompt);
  });

  it('codex 也一樣:`exec -` 讀 stdin', () => {
    const cmd = codexCli.command({ prompt: '- list' });
    expect(cmd.stdin).toBe('- list');
    expect(cmd.args.slice(0, 2)).toEqual(['exec', '-']);
  });
});

describe('codex —— 同一份意圖翻成沙箱等級', () => {
  it('read-only 與 none 都對應 read-only 沙箱', () => {
    expect(sandboxFor({ filesystem: 'read-only' })).toBe('read-only');
    expect(sandboxFor({ filesystem: 'none' })).toBe('read-only');
  });

  it('workspace-write 對應同名沙箱', () => {
    expect(sandboxFor({ filesystem: 'workspace-write' })).toBe('workspace-write');
  });

  it('沒宣告就不下 -s,交給 codex 自己的設定', () => {
    expect(sandboxFor(undefined)).toBeUndefined();
    expect(codexCli.command({ prompt: 'x' }).args).not.toContain('-s');
  });

  it('shell: false 表達不了 → 明確拒絕,不靜默降級', () => {
    // 靜默降級成 workspace-write 會讓 manifest 上寫著的限制在這個 runtime 默默失效。
    expect(() => sandboxFor({ shell: false })).toThrow(EngineError);
    expect(() => sandboxFor({ shell: false })).toThrow(/shell: false/);
  });
});

describe('兩個 runtime 的能力不等價', () => {
  it('skills 只有 claude 有 —— 能力協商的依據', () => {
    expect(claudeCli.capabilities.skills).toBe(true);
    expect(codexCli.capabilities.skills).toBe(false);
  });

  it('兩者都觀測不到步數,所以都不可宣告 maxSteps', () => {
    expect(claudeCli.capabilities.maxSteps).toBe(false);
    expect(codexCli.capabilities.maxSteps).toBe(false);
  });

  it('同一份 capabilities 產出完全不同的旗標', () => {
    const capabilities = { filesystem: 'read-only' } as const;
    const claude = claudeCli.command({ prompt: 'p', capabilities });
    const codex = codexCli.command({ prompt: 'p', capabilities });

    expect(claude.file).toBe('claude');
    expect(claude.args).toEqual(expect.arrayContaining(['--tools', 'Read,Grep,Glob']));

    expect(codex.file).toBe('codex');
    expect(codex.args).toEqual(expect.arrayContaining(['-s', 'read-only']));
    expect(codex.args).not.toContain('--tools');
  });
});
