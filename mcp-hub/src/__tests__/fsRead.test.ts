import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createFsReadTools, globToRegExp } from '../tools/fsRead.js';
import { PACKAGE_ROOT } from '../shared/paths.js';
import { ToolFailure } from '../types.js';
import type { BuiltinTool } from '../types.js';

/**
 * 唯讀檔案工具。重點是**沙箱**:路徑出界、symlink 逃逸、金鑰檔、`.git` / `node_modules` 都必須擋得住,
 * 而且「被擋」要是明確的失敗(ToolFailure),不能偽裝成「沒有符合的檔案」。
 */

let outer: string;   // 沙箱之外(放「不該被讀到」的東西)
let root: string;    // 沙箱
let tools: Record<string, BuiltinTool<string>>;
const ac = () => new AbortController().signal;
const run = (name: string, args: Record<string, unknown> = {}, signal = ac()) => tools[name].execute(args, signal);
const fails = async (p: Promise<string>, re: RegExp) => {
  const e = await p.then(() => undefined, (x) => x);
  expect(e).toBeInstanceOf(ToolFailure);
  expect((e as Error).message).toMatch(re);
};

beforeAll(() => {
  outer = realpathSync(mkdtempSync(join(tmpdir(), 'fs-outer-')));
  root = join(realpathSync(mkdtempSync(join(tmpdir(), 'fs-root-'))));
  writeFileSync(join(outer, 'outside-secret.txt'), 'TOP SECRET outside');
  mkdirSync(join(outer, 'outdir'));
  writeFileSync(join(outer, 'outdir', 'hidden.ts'), 'needle in outside dir');

  mkdirSync(join(root, 'src', 'deep'), { recursive: true });
  writeFileSync(join(root, 'README.md'), 'line1\nline2\nline3\n');
  writeFileSync(join(root, 'src', 'a.ts'), 'export const needle = 1;\nconst other = 2;\n');
  writeFileSync(join(root, 'src', 'deep', 'b.ts'), 'NEEDLE upper\nplain\n');
  writeFileSync(join(root, 'src', 'c.cs'), 'class Needle {}\n');
  writeFileSync(join(root, 'empty.txt'), '');
  writeFileSync(join(root, 'bin.dat'), Buffer.from([1, 2, 0, 3, 4]));
  writeFileSync(join(root, 'long.txt'), Array.from({ length: 50 }, (_, i) => `row${i + 1}`).join('\n'));
  // 受保護的
  writeFileSync(join(root, '.env'), 'TOKEN=abc needle');
  writeFileSync(join(root, 'config.env'), 'JIRA=abc needle');
  writeFileSync(join(root, 'secrets.json'), '{"k":"needle"}');
  writeFileSync(join(root, 'id_rsa'), 'needle private key');
  mkdirSync(join(root, '.git')); writeFileSync(join(root, '.git', 'config'), 'needle git');
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true }); writeFileSync(join(root, 'node_modules', 'pkg', 'i.js'), 'needle dep');
  // symlink 逃逸
  symlinkSync(join(outer, 'outside-secret.txt'), join(root, 'link-file'));
  symlinkSync(join(outer, 'outdir'), join(root, 'link-dir'));

  tools = Object.fromEntries(createFsReadTools({ roots: [root], maxResults: 5 }).map((t) => [t.name, t]));
});
afterAll(() => { rmSync(outer, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); });

describe('globToRegExp', () => {
  const m = (g: string, p: string) => globToRegExp(g).test(p);
  it('* 不跨目錄,** 跨目錄', () => {
    expect(m('*.ts', 'a.ts')).toBe(true);
    expect(m('*.ts', 'src/a.ts')).toBe(false);
    expect(m('src/**/*.ts', 'src/a.ts')).toBe(true);
    expect(m('src/**/*.ts', 'src/deep/b.ts')).toBe(true);
    expect(m('**/*.ts', 'x/y/z.ts')).toBe(true);
  });
  it('? / {a,b} / [..] / 特殊字元跳脫', () => {
    expect(m('a?.ts', 'ab.ts')).toBe(true);
    expect(m('*.{ts,cs}', 'x.cs')).toBe(true);
    expect(m('*.{ts,cs}', 'x.js')).toBe(false);
    expect(m('[ab].ts', 'a.ts')).toBe(true);
    expect(m('a.ts', 'aXts')).toBe(false); // . 是字面
    expect(m('a+b(1).ts', 'a+b(1).ts')).toBe(true);
  });
});

describe('fs_read_file', () => {
  it('帶行號讀整檔', async () => {
    expect(await run('fs_read_file', { path: 'README.md' })).toBe('     1\tline1\n     2\tline2\n     3\tline3');
  });
  it('offset / limit 分段,並告訴模型怎麼接著讀', async () => {
    const out = await run('fs_read_file', { path: 'long.txt', offset: 10, limit: 3 });
    expect(out).toContain('    10\trow10');
    expect(out).toContain('    12\trow12');
    expect(out).not.toContain('row13');
    expect(out).toContain('顯示第 10–12 行,共 50 行');
    expect(out).toContain('offset=13');
  });
  it('空檔案是正常結果,不是失敗', async () => {
    expect(await run('fs_read_file', { path: 'empty.txt' })).toContain('空檔案');
  });
  it('offset 超過行數 → 失敗', () => fails(run('fs_read_file', { path: 'README.md', offset: 99 }), /超過檔案行數/));
  it('目錄 / 不存在 / 二進位 → 明確失敗', async () => {
    await fails(run('fs_read_file', { path: 'src' }), /目錄不是檔案/);
    await fails(run('fs_read_file', { path: 'nope.txt' }), /路徑不存在/);
    await fails(run('fs_read_file', { path: 'bin.dat' }), /二進位/);
    await fails(run('fs_read_file', {}), /缺少參數 path/);
  });
  it('大檔拒讀並指引用 grep / 分段', async () => {
    const small = createFsReadTools({ roots: [root], maxFileBytes: 10 }).find((t) => t.name === 'fs_read_file')!;
    await fails(small.execute({ path: 'long.txt' }, ac()), /檔案太大/);
  });
});

describe('沙箱:路徑出界', () => {
  it('.. 跳出 root → 存取被拒(不是「不存在」)', async () => {
    await fails(run('fs_read_file', { path: '../' + outer.split('/').pop() + '/outside-secret.txt' }), /存取被拒/);
  });
  it('絕對路徑在 root 外 → 存取被拒', () => fails(run('fs_read_file', { path: join(outer, 'outside-secret.txt') }), /存取被拒/));
  it('root 內的 symlink 指到 root 外(檔案)→ 存取被拒', () => fails(run('fs_read_file', { path: 'link-file' }), /存取被拒/));
  it('root 內的 symlink 指到 root 外(目錄)→ 列 / 讀都被拒', async () => {
    await fails(run('fs_list_dir', { path: 'link-dir' }), /存取被拒/);
    await fails(run('fs_read_file', { path: 'link-dir/hidden.ts' }), /存取被拒/);
  });
  it('絕對路徑在 root 內 → 可以', async () => {
    expect(await run('fs_read_file', { path: join(root, 'README.md') })).toContain('line1');
  });
});

describe('沙箱:受保護的路徑', () => {
  it('明確讀取 → 存取被拒(金鑰、.env、.git、node_modules)', async () => {
    for (const p of ['.env', 'config.env', 'secrets.json', 'id_rsa', '.git/config', 'node_modules/pkg/i.js']) {
      await fails(run('fs_read_file', { path: p }), /存取被拒/);
    }
  });
  it('列目錄看不到受保護的項目與 symlink', async () => {
    const out = (await run('fs_list_dir')).split('\n');
    expect(out).toEqual(expect.arrayContaining(['README.md', 'src/', 'long.txt']));
    for (const hidden of ['.env', 'config.env', 'secrets.json', 'id_rsa', '.git/', 'node_modules/', 'link-file', 'link-dir/']) {
      expect(out).not.toContain(hidden);
    }
  });
  it('額外的 deny 樣式生效', async () => {
    const t = createFsReadTools({ roots: [root], deny: ['*.dat'] }).find((x) => x.name === 'fs_read_file')!;
    await fails(t.execute({ path: 'bin.dat' }, ac()), /存取被拒/);
  });
});

describe('fs_list_dir', () => {
  it('目錄尾端帶 /,依字母排序', async () => {
    expect(await run('fs_list_dir', { path: 'src' })).toBe('a.ts\nc.cs\ndeep/');
  });
  it('檔案 → 失敗;空目錄 → 正常', async () => {
    await fails(run('fs_list_dir', { path: 'README.md' }), /是檔案不是目錄/);
    mkdirSync(join(root, 'emptydir'), { recursive: true });
    expect(await run('fs_list_dir', { path: 'emptydir' })).toBe('(空目錄)');
  });
});

describe('fs_glob', () => {
  it('不含 / → 任何層級的檔名', async () => {
    expect((await run('fs_glob', { pattern: '*.ts' })).split('\n')).toEqual(['src/a.ts', 'src/deep/b.ts']);
  });
  it('含 / → 比對相對路徑', async () => {
    expect(await run('fs_glob', { pattern: 'src/*.ts' })).toBe('src/a.ts');
    expect(await run('fs_glob', { pattern: '**/*.{ts,cs}', path: 'src' })).toBe('src/a.ts\nsrc/c.cs\nsrc/deep/b.ts');
  });
  it('不會列出受保護的檔案、symlink 內的東西', async () => {
    const all = await run('fs_glob', { pattern: '*' });
    for (const hidden of ['.env', 'config.env', 'secrets.json', 'id_rsa', '.git', 'node_modules', 'link-file', 'hidden.ts']) {
      expect(all).not.toContain(hidden);
    }
  });
  it('沒有符合 → 正常回「沒有」,不是失敗', async () => {
    expect(await run('fs_glob', { pattern: '*.zzz' })).toBe('(沒有符合的檔案)');
  });
  it('超過筆數上限 → 截斷並標註總數', async () => {
    const out = await run('fs_glob', { pattern: '*' });
    expect(out).toMatch(/共 \d+ 個,只列前 5/);
    expect(out.split('\n').filter((l) => !l.startsWith('…')).length).toBe(5);
  });
});

describe('fs_grep', () => {
  it('回「路徑:行號:內容」', async () => {
    expect(await run('fs_grep', { pattern: 'needle', glob: '*.ts' })).toBe('src/a.ts:1:export const needle = 1;');
  });
  it('ignoreCase', async () => {
    const out = await run('fs_grep', { pattern: 'needle', ignoreCase: true, glob: '*.{ts,cs}' });
    expect(out.split('\n')).toEqual(['src/a.ts:1:export const needle = 1;', 'src/c.cs:1:class Needle {}', 'src/deep/b.ts:1:NEEDLE upper']);
  });
  it('path 限縮目錄 / 單一檔案', async () => {
    expect(await run('fs_grep', { pattern: 'plain', path: 'src/deep' })).toBe('src/deep/b.ts:2:plain');
    expect(await run('fs_grep', { pattern: 'plain', path: 'src/deep/b.ts' })).toBe('src/deep/b.ts:2:plain');
  });
  it('不會搜到受保護的檔案、symlink 指向的外部內容、二進位檔', async () => {
    const out = await run('fs_grep', { pattern: 'needle|TOP SECRET|TOKEN' , ignoreCase: true });
    for (const hidden of ['.env', 'config.env', 'secrets.json', 'id_rsa', '.git', 'node_modules', 'hidden.ts', 'outside', 'bin.dat']) {
      expect(out).not.toContain(hidden);
    }
    expect(out).toContain('src/a.ts');
  });
  it('沒有符合 → 正常;正規表示式不合法 → 失敗', async () => {
    expect(await run('fs_grep', { pattern: 'zzz-no-match' })).toBe('(沒有符合的內容)');
    await fails(run('fs_grep', { pattern: '(' }), /正規表示式不合法/);
  });
  it('達到筆數上限 → 截斷並提示', async () => {
    writeFileSync(join(root, 'many.txt'), Array.from({ length: 20 }, (_, i) => `hit ${i}`).join('\n'));
    const out = await run('fs_grep', { pattern: 'hit', glob: 'many.txt' });
    expect(out.split('\n').filter((l) => l.startsWith('many.txt')).length).toBe(5);
    expect(out).toContain('已達 5 筆上限');
  });
  it('單行過長會截短,輸出不會灌爆 context', async () => {
    writeFileSync(join(root, 'wide.txt'), 'x'.repeat(5000) + ' needle');
    const out = await run('fs_grep', { pattern: 'x{10}', glob: 'wide.txt' });
    expect(out.length).toBeLessThan(400);
  });
});

describe('fs_grep:病態 regex 有逾時(ReDoS)', () => {
  let proj: string;
  let g: Record<string, BuiltinTool<string>>;
  beforeAll(() => {
    proj = realpathSync(mkdtempSync(join(tmpdir(), 'fs-redos-')));
    writeFileSync(join(proj, 'evil.txt'), `ok\n${'a'.repeat(40)}!\nok\n`);
    writeFileSync(join(proj, 'fine.txt'), 'aaa\nneedle here\n');
    g = Object.fromEntries(createFsReadTools({ roots: [proj], grepTimeoutMs: 150 }).map((x) => [x.name, x]));
  });
  afterAll(() => rmSync(proj, { recursive: true, force: true }));

  it('巢狀量詞在單檔上限內中斷 → ToolFailure(指出檔案與怎麼改),不是「沒有符合」,也不會卡住', async () => {
    const t0 = Date.now();
    await fails(g.fs_grep.execute({ pattern: '(a+)+$', path: 'evil.txt' }, ac()), /逾時.*evil\.txt.*災難性回溯/s);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('逾時之後同一組工具照常運作(vm context 沒有留下上一次的狀態)', async () => {
    await g.fs_grep.execute({ pattern: '(a+)+$', path: 'evil.txt' }, ac()).catch(() => {});
    expect(await g.fs_grep.execute({ pattern: 'needle' }, ac())).toBe('fine.txt:2:needle here');
  });

  it('筆數上限語意不變:剛好滿額不標截斷,超過才標', async () => {
    const lim = Object.fromEntries(createFsReadTools({ roots: [proj], maxResults: 2 }).map((x) => [x.name, x]));
    writeFileSync(join(proj, 'two.txt'), 'hit\nhit\n');
    expect(await lim.fs_grep.execute({ pattern: 'hit', path: 'two.txt' }, ac())).toBe('two.txt:1:hit\ntwo.txt:2:hit');
    writeFileSync(join(proj, 'three.txt'), 'hit\nhit\nhit\n');
    expect(await lim.fs_grep.execute({ pattern: 'hit', path: 'three.txt' }, ac())).toContain('已達 2 筆上限');
  });
});

describe('取消', () => {
  it('signal 已取消 → AbortError 往上丟,不偽裝成工具失敗', async () => {
    const c = new AbortController(); c.abort();
    const e = await run('fs_glob', { pattern: '*' }, c.signal).then(() => undefined, (x) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(ToolFailure);
    expect(e.name).toBe('AbortError');
  });
});

describe('createFsReadTools 設定', () => {
  it('roots 空 / 不存在 → 啟動就失敗', () => {
    expect(() => createFsReadTools({ roots: [] })).toThrow('roots');
    expect(() => createFsReadTools({ roots: [join(root, 'nope')] })).toThrow('root 不存在');
  });
  it('四個工具,而且沒有任何寫入工具', () => {
    expect(Object.keys(tools).sort()).toEqual(['fs_glob', 'fs_grep', 'fs_list_dir', 'fs_read_file']);
  });
});

describe('allowTop:只開放指定的頂層目錄(預設拒絕)', () => {
  let proj: string;
  let t: Record<string, BuiltinTool<string>>;
  const go = (name: string, args: Record<string, unknown> = {}) => t[name].execute(args, ac());

  beforeAll(() => {
    proj = realpathSync(mkdtempSync(join(tmpdir(), 'fs-allow-')));
    for (const d of ['repos/app/src', 'domain/ASPlus', 'results', 'csd-digest/ingest', 'tmp', 'guardian/src', 'logs']) mkdirSync(join(proj, d), { recursive: true });
    writeFileSync(join(proj, 'repos', 'app', 'src', 'a.ts'), 'export const needle = 1;\n');
    writeFileSync(join(proj, 'repos', 'app', 'cache.sqlite'), 'needle sqlite');
    writeFileSync(join(proj, 'repos', 'app', 'data.db'), 'needle db');
    writeFileSync(join(proj, 'domain', 'ASPlus', 'knowledge.md'), 'needle knowledge\n');
    writeFileSync(join(proj, 'results', 'run.json'), '{"needle":1}');
    writeFileSync(join(proj, 'csd-digest', 'ingest', 'x.jsonl'), 'needle other-site customer');
    writeFileSync(join(proj, 'tmp', 't.txt'), 'needle tmp');
    writeFileSync(join(proj, 'guardian', 'src', 'bot.ts'), 'needle bot internals');
    writeFileSync(join(proj, 'logs', 'bot.log'), 'needle log');
    writeFileSync(join(proj, 'package.json'), '{"needle":true}');
    writeFileSync(join(proj, 'notes.txt'), 'needle root file');
    t = Object.fromEntries(createFsReadTools({ roots: [proj], allowTop: ['repos', 'domain'] }).map((x) => [x.name, x]));
  });
  afterAll(() => rmSync(proj, { recursive: true, force: true }));

  it('允許的目錄照常讀(相對路徑仍以專案根為基準)', async () => {
    expect(await go('fs_read_file', { path: 'repos/app/src/a.ts' })).toContain('needle');
    expect(await go('fs_read_file', { path: 'domain/ASPlus/knowledge.md' })).toContain('knowledge');
  });

  it('不在清單的頂層目錄與根目錄下的檔案 → 存取被拒(明確失敗,不是「不存在」)', async () => {
    for (const p of ['results/run.json', 'csd-digest/ingest/x.jsonl', 'tmp/t.txt', 'guardian/src/bot.ts', 'logs/bot.log', 'package.json', 'notes.txt']) {
      await fails(go('fs_read_file', { path: p }), /存取被拒.*不在開放的目錄內.*repos、domain/s);
    }
    await fails(go('fs_list_dir', { path: 'csd-digest' }), /存取被拒/);
  });

  it('錯誤訊息可執行:告訴模型下一步(直接回報、別猜路徑),不只說「被拒」', async () => {
    await fails(go('fs_read_file', { path: 'notes.txt' }), /不要猜其他路徑.*直接回報/s);
    await fails(go('fs_read_file', { path: 'repos/nope.ts' }), /fs_list_dir.*直接回報「找不到」.*不要猜/s);
    await fails(go('fs_read_file', { path: '/etc/hosts' }), /只用專案內的相對路徑.*不要嘗試繞過/s);
    await fails(go('fs_read_file', { path: 'repos/app/cache.sqlite' }), /不要嘗試繞過.*直接回報/s);
  });

  it('列根目錄只看得到被允許的目錄', async () => {
    expect((await go('fs_list_dir')).split('\n')).toEqual(['domain/', 'repos/']);
  });

  it('glob / grep 從根目錄開始也不會走進沒開放的目錄', async () => {
    const hits = await go('fs_grep', { pattern: 'needle' });
    expect(hits).toContain('repos/app/src/a.ts:1');
    expect(hits).toContain('domain/ASPlus/knowledge.md:1');
    for (const leak of ['results', 'csd-digest', 'tmp', 'guardian', 'logs', 'package.json', 'notes.txt']) expect(hits).not.toContain(leak);
    expect(await go('fs_glob', { pattern: '**/*.jsonl' })).toBe('(沒有符合的檔案)');
  });

  it('資料庫檔(*.sqlite / *.db)預設拒絕,即使在允許的目錄內', async () => {
    await fails(go('fs_read_file', { path: 'repos/app/cache.sqlite' }), /存取被拒/);
    await fails(go('fs_read_file', { path: 'repos/app/data.db' }), /存取被拒/);
    expect(await go('fs_grep', { pattern: 'needle', path: 'repos' })).not.toMatch(/sqlite|data\.db/);
    expect(await go('fs_list_dir', { path: 'repos/app' })).not.toMatch(/sqlite|data\.db/);
  });

  it('沒設 allowTop = 舊行為(整個 root 除了 denylist)', async () => {
    const open = Object.fromEntries(createFsReadTools({ roots: [proj] }).map((x) => [x.name, x]));
    expect(await open.fs_read_file.execute({ path: 'notes.txt' }, ac())).toContain('needle');
  });
});

const SERVER = join(PACKAGE_ROOT, 'dist', 'bin', 'fsServer.js');
const describeBuilt = existsSync(SERVER) ? describe : describe.skip;
describeBuilt('fsServer(stdio,真的子程序)', () => {
  it('列得到四個工具;FS_READ_ROOTS 決定範圍;出界被拒', async () => {
    const client = new Client({ name: 'fs-test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: [SERVER], stderr: 'ignore',
      env: { ...process.env as Record<string, string>, FS_READ_ROOTS: root },
    }));
    try {
      expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['fs_glob', 'fs_grep', 'fs_list_dir', 'fs_read_file']);
      const ok: any = await client.callTool({ name: 'fs_read_file', arguments: { path: 'README.md' } });
      expect(ok.isError).toBeFalsy();
      expect(ok.content[0].text).toContain('line1');
      const denied: any = await client.callTool({ name: 'fs_read_file', arguments: { path: '.env' } });
      expect(denied.isError).toBe(true);
      expect(denied.content[0].text).toContain('存取被拒');
    } finally { await client.close(); }
  });
});

describeBuilt('fsServer FS_READ_ALLOW_TOP(stdio,真的子程序)', () => {
  it('環境變數設的頂層允許清單生效:允許的可讀、其他被拒', async () => {
    const client = new Client({ name: 'fs-test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: [SERVER], stderr: 'ignore',
      env: { ...process.env as Record<string, string>, FS_READ_ROOTS: root, FS_READ_ALLOW_TOP: 'src' },
    }));
    try {
      const ok: any = await client.callTool({ name: 'fs_read_file', arguments: { path: 'src/a.ts' } });
      expect(ok.isError).toBeFalsy();
      const denied: any = await client.callTool({ name: 'fs_read_file', arguments: { path: 'README.md' } });
      expect(denied.isError).toBe(true);
      expect(denied.content[0].text).toContain('不在開放的目錄內');
    } finally { await client.close(); }
  });
});
