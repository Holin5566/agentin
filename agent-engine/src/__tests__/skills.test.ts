import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSkillChecker, resolveClaudeConfigDir } from '../agents/skills.js';

/**
 * 這個預檢擋的是一個很貴的失敗:plugin 沒被重新 enable 時,子程序叫它**不會
 * fail-fast** —— 卡著、沒輸出、一路撐到逾時。十分鐘換一份空白報告。
 *
 * 所以測試要涵蓋「看起來裝了其實沒裝」的各種形狀,不只是「有沒有這個 key」。
 */

let configDir: string;

beforeEach(() => { configDir = mkdtempSync(join(tmpdir(), 'agent-engine-skills-')); });
afterEach(() => rmSync(configDir, { recursive: true, force: true }));

/**
 * 依真實的 installed_plugins.json 形狀寫一份 registry。預設也在 settings.json 把它們 enable ——
 * 這組測試驗的是 registry 那一層;enable 那一層見下面的 describe。
 */
function writeRegistry(plugins: Record<string, Array<{ installPath: string }>>, enable = true): void {
  mkdirSync(join(configDir, 'plugins'), { recursive: true });
  writeFileSync(
    join(configDir, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins }),
  );
  if (enable) writeSettings(configDir, Object.fromEntries(Object.keys(plugins).map((k) => [k, true])));
}

/** `<dir>/settings.json`(user 層)或 `<project>/.claude/settings*.json` 的 enabledPlugins。 */
function writeSettings(dir: string, enabledPlugins: Record<string, boolean>, file = 'settings.json'): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), JSON.stringify({ enabledPlugins }));
}

/** 造一個裝好的 plugin 目錄。`skills` 留空 = 註冊了但半殘。 */
function installDir(name: string, skills: string[]): string {
  const path = join(configDir, 'cache', name);
  mkdirSync(path, { recursive: true });
  for (const skill of skills) {
    mkdirSync(join(path, 'skills', skill), { recursive: true });
    writeFileSync(join(path, 'skills', skill, 'SKILL.md'), '# skill');
  }
  return path;
}

const check = () => createSkillChecker({ configDir });

describe('裝好的情況', () => {
  it('註冊且有 skill 檔 = 可用', () => {
    writeRegistry({ 'elk@at-tools': [{ installPath: installDir('elk', ['elk']) }] });
    expect(check()('elk')).toEqual({ available: true, reason: '' });
  });

  it('manifest 只寫短名,registry 的 key 帶 marketplace 後綴也配得到', () => {
    writeRegistry({ 'qland@at-tools': [{ installPath: installDir('qland', ['qland']) }] });
    expect(check()('qland').available).toBe(true);
  });

  it('skill 檔名跟 plugin 短名不同也算數', () => {
    // prometheus plugin 的檔案在 skills/query/ —— 這個對應關係不是慣例,
    // 推不出來,所以只驗「有裝 skill」而不驗特定路徑。
    writeRegistry({ 'prometheus@at-tools': [{ installPath: installDir('prometheus', ['query']) }] });
    expect(check()('prometheus').available).toBe(true);
  });

  it('同一短名來自多個 marketplace 時,任一個裝好就算數', () => {
    writeRegistry({
      'elk@stale': [{ installPath: installDir('elk-stale', []) }],
      'elk@at-tools': [{ installPath: installDir('elk-good', ['elk']) }],
    });
    expect(check()('elk').available).toBe(true);
  });
});

describe('看起來裝了其實沒裝', () => {
  it('完全沒註冊', () => {
    writeRegistry({});
    expect(check()('elk')).toMatchObject({ available: false, reason: expect.stringMatching(/未註冊/) });
  });

  it('註冊了但安裝目錄不存在', () => {
    writeRegistry({ 'elk@at-tools': [{ installPath: join(configDir, 'cache', 'gone') }] });
    expect(check()('elk').available).toBe(false);
  });

  it('註冊了但安裝目錄沒有 skill 檔 —— 升級留下的空殼', () => {
    // 這是真實會發生的:cache 裡同時有 elk/2.1.0(空)與 elk/2.1.2(完整)。
    writeRegistry({ 'elk@at-tools': [{ installPath: installDir('elk-empty', []) }] });
    const r = check()('elk');
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/沒有 skill 檔/);
  });

  it('有 skills 目錄但裡面沒有 SKILL.md', () => {
    const path = join(configDir, 'cache', 'half');
    mkdirSync(join(path, 'skills', 'elk'), { recursive: true });
    writeRegistry({ 'elk@at-tools': [{ installPath: path }] });
    expect(check()('elk').available).toBe(false);
  });

  it('registry 檔不存在時回不可用,而不是當成都裝好了', () => {
    // 失敗方向只能往嚴:讀不到就當沒裝,不要放行。
    const r = check()('elk');
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/讀不到/);
  });

  it('registry 是壞 JSON 時不炸,回不可用', () => {
    mkdirSync(join(configDir, 'plugins'), { recursive: true });
    writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), '{ not json');
    expect(check()('elk').available).toBe(false);
  });
});

describe('enable 狀態(換機 / marketplace 重裝後掉 enable)', () => {
  it('裝了但 enabledPlugins 沒寫 = 沒 enable,訊息指出要改哪裡', () => {
    writeRegistry({ 'elk@at-tools': [{ installPath: installDir('elk', ['elk']) }] }, false);
    const r = check()('elk');
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/沒有 enable.*enabledPlugins.*"elk@at-tools"/);
  });

  it('明確設成 false 也擋', () => {
    writeRegistry({ 'elk@at-tools': [{ installPath: installDir('elk', ['elk']) }] }, false);
    writeSettings(configDir, { 'elk@at-tools': false });
    expect(check()('elk').available).toBe(false);
  });

  it('專案層的設定蓋過 user 層:project enable、project-local 再 disable', () => {
    const project = mkdtempSync(join(tmpdir(), 'agent-engine-project-'));
    try {
      writeRegistry({ 'elk@at-tools': [{ installPath: installDir('elk', ['elk']) }] }, false);
      const checkIn = () => createSkillChecker({ configDir, projectDir: project });
      writeSettings(join(project, '.claude'), { 'elk@at-tools': true });
      expect(checkIn()('elk').available).toBe(true);
      writeSettings(join(project, '.claude'), { 'elk@at-tools': false }, 'settings.local.json');
      expect(checkIn()('elk').available).toBe(false);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('同一短名多個 marketplace:只看有 enable 的那個裝得好不好', () => {
    writeRegistry({
      'elk@stale': [{ installPath: installDir('elk-good', ['elk']) }],
      'elk@at-tools': [{ installPath: installDir('elk-empty', []) }],
    }, false);
    writeSettings(configDir, { 'elk@at-tools': true });
    expect(check()('elk').reason).toMatch(/沒有 skill 檔/);
  });
});

describe('快取', () => {
  it('registry 改了會重讀 —— marketplace 重裝可能在程序跑著時發生', () => {
    const checker = check();
    writeRegistry({});
    expect(checker('elk').available).toBe(false);

    // 用 mtime 當 cache key,所以不必重建 checker。
    const path = installDir('elk', ['elk']);
    const registry = join(configDir, 'plugins', 'installed_plugins.json');
    const { utimesSync } = require('node:fs') as typeof import('node:fs');
    writeRegistry({ 'elk@at-tools': [{ installPath: path }] });
    utimesSync(registry, new Date(), new Date(Date.now() + 1000));

    expect(checker('elk').available).toBe(true);
  });
});

describe('設定目錄的判斷', () => {
  it('CLAUDE_CONFIG_DIR 優先', () => {
    expect(resolveClaudeConfigDir({ CLAUDE_CONFIG_DIR: '/custom', HOME: '/home/x' })).toBe('/custom');
  });

  it('否則用 $HOME/.claude —— 要跟子程序等一下會讀到的目錄一致', () => {
    expect(resolveClaudeConfigDir({ HOME: '/home/x' })).toBe('/home/x/.claude');
  });

  it('空字串不算指定', () => {
    expect(resolveClaudeConfigDir({ CLAUDE_CONFIG_DIR: '  ', HOME: '/home/x' })).toBe('/home/x/.claude');
  });
});
