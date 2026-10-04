import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { execRuntime } from '../run/exec.js';
import { trackedGroupCount } from '../run/childGroups.js';

/**
 * 宿主要真的死掉才驗得到,所以宿主是另一個 node 程序,載入建置好的 dist(`npm test` 的 pretest
 * 會先 build)。宿主用 execRuntime 跑一個子程序,子程序再起一個帶 tag 的孫程序,然後我們讓宿主死。
 */
const EXEC_DIST = join(__dirname, '..', '..', 'dist', 'run', 'exec.js');

const alive = (tag: string) => spawnSync('/bin/sh', ['-c', `ps -eo args | grep -F '${tag}' | grep -v grep || true`], { encoding: 'utf8' })
  .stdout.split('\n').filter(Boolean).length;

async function waitFor(check: () => boolean, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

/**
 * 起一個宿主;它跑的子程序會 spawn 一個常駐的孫程序,並印 READY。tag 走環境變數,只有孫程序的
 * argv 帶著它 —— 寫進腳本字串的話,宿主與子程序的 argv 也會被 `ps` 比對到。
 */
function startHost(tag: string, hostPrelude = '') {
  // 子程序是 group leader,印出自己的 pid,測試收尾時才殺得到整組(斷言失敗也不留孤兒)。
  const grandchild = `require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', process.env.CG_TAG], { stdio: 'ignore' });`
    + `console.log('READY ' + process.pid); setInterval(()=>{},1000);`;
  const host = `${hostPrelude}
    const { execRuntime } = await import(${JSON.stringify(EXEC_DIST)});
    execRuntime({ command: { file: process.execPath, args: ['-e', ${JSON.stringify(grandchild)}] },
      onEvent: (e) => { if (e.type === 'text' && e.chunk.includes('READY')) process.stdout.write(e.chunk); } });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', host],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CG_TAG: tag } });
  let out = '';
  child.stdout.on('data', (b) => {
    out += b;
    const group = /READY (\d+)/.exec(out)?.[1];
    if (group) groups.add(Number(group));
  });
  hosts.add(child);
  const ready = waitFor(() => out.includes('READY'));
  const exited = new Promise<[number | null, NodeJS.Signals | null]>((ok) => child.on('exit', (c, s) => ok([c, s])));
  return { child, ready, exited };
}

const hosts = new Set<ChildProcess>();
const groups = new Set<number>();
afterEach(() => {
  for (const h of hosts) if (h.exitCode === null && h.signalCode === null) h.kill('SIGKILL');
  for (const g of groups) { try { process.kill(-g, 'SIGKILL'); } catch { /* 已經不在 */ } }
  hosts.clear();
  groups.clear();
});

describe.skipIf(process.platform === 'win32')('宿主結束時帶走 runtime 的 process group', () => {
  it.skipIf(!existsSync(EXEC_DIST))('宿主沒接訊號、被 SIGTERM 砍掉(pm2 重啟的情況):孫程序跟著消失,宿主照預設方式結束', async () => {
    const tag = `cg-${randomUUID()}`;
    const { child, ready, exited } = startHost(tag);
    expect(await ready).toBe(true);
    expect(alive(tag)).toBe(1);
    child.kill('SIGTERM');
    const [, signal] = await exited;
    expect(signal).toBe('SIGTERM'); // 結束方式跟沒掛 hook 一樣
    expect(await waitFor(() => alive(tag) === 0)).toBe(true);
  }, 20_000);

  it.skipIf(!existsSync(EXEC_DIST))('宿主自己接了 SIGINT(例如 Ctrl+C 取消回覆):不動它的 group;宿主之後 exit 時才收掉', async () => {
    const tag = `cg-${randomUUID()}`;
    const { child, ready, exited } = startHost(tag,
      `process.on('SIGINT', () => { process.stdout.write('HOST-SIGINT\\n'); setTimeout(() => process.exit(0), 300); });`);
    expect(await ready).toBe(true);
    child.kill('SIGINT');
    // 宿主的 handler 跑了、還沒 exit 的這段時間,孫程序要還活著
    await new Promise((r) => setTimeout(r, 100));
    expect(alive(tag)).toBe(1);
    const [code] = await exited;
    expect(code).toBe(0);
    expect(await waitFor(() => alive(tag) === 0)).toBe(true);
  }, 20_000);

  it('正常收乾淨的 take 會除名,不留著等宿主結束才殺', async () => {
    const before = trackedGroupCount();
    await execRuntime({ command: { file: process.execPath, args: ['-e', 'console.log(1)'] } });
    expect(trackedGroupCount()).toBe(before);
  });
});
