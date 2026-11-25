/**
 * `serveBuiltinStdio`:宿主把自己的工具做成 stdio server,讓 `claude -p` 那條跨程序
 * 的路也用得到。這裡用真的子程序驗 —— in-process 測不出收尾有沒有做對。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PACKAGE_ROOT } from '../shared/paths.js';

const SERVER = join(__dirname, 'fixture', 'builtin-stdio-server.cjs');
const built = existsSync(join(PACKAGE_ROOT, 'dist', 'index.js'));
const describeBuilt = built ? describe : describe.skip;
if (!built) console.warn('[builtinStdio] 跳過 —— 缺 dist/index.js(先跑 npm run build)');

const textOf = (r: any): string =>
  (r?.content ?? []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n');

describeBuilt('serveBuiltinStdio', () => {
  it('列得到注入的工具,呼叫結果照三態回', async () => {
    const client = new Client({ name: 'builtin-stdio-test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], stderr: 'ignore' }));
    try {
      expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['echo', 'fail']);

      const ok: any = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
      expect(ok.isError).toBeFalsy();
      expect(textOf(ok)).toBe('echoed: hi');

      // ToolFailure 是工具回報的失敗(isError),不是協議錯誤 —— 模型看得到原因。
      const fail: any = await client.callTool({ name: 'fail', arguments: {} });
      expect(fail.isError).toBe(true);
      expect(textOf(fail)).toContain('expected failure');
      expect(textOf(fail)).toContain('detail here');
    } finally {
      await client.close();
    }
  }, 30_000);

  it('stdin 關掉就自己退出 —— 呼叫端被 SIGKILL 時不留孤兒程序', async () => {
    const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += String(d); });
    await new Promise<void>((resolve) => {
      const wait = () => (stderr.includes('ready') ? resolve() : setTimeout(wait, 20));
      wait();
    });

    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    child.stdin.end(); // 模擬 gateway 消失:只有管線斷,沒有任何訊號
    const code = await Promise.race([exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 5000))]);
    if (code === 'timeout') child.kill('SIGKILL');

    expect(code).toBe(0);
    expect(stderr).toContain('stdin');
  }, 30_000);
});
