/**
 * 內建的 skill 預檢:**純讀檔**確認 plugin 真的裝好了。
 *
 * 為什麼需要:換機或 marketplace 重裝之後,plugin 可能沒被重新 enable(`settings.json` 的
 * `enabledPlugins`)、或註冊了但安裝目錄是空的。此時
 * 子程序叫一個未註冊的 skill **不會 fail-fast** —— 它卡著嘗試、完全沒輸出,
 * 一路撐到逾時才被砍。十分鐘換一份空白報告。
 *
 * 這支在開跑前用讀檔確認(不 spawn,所以自己不會跟著 hang),沒過就讓 take
 * 立刻收尾 —— 十分鐘的 hang 換成 <10ms 的明確錯誤。
 *
 * 實際的檔案結構(對本機 `installed_plugins.json` 核對過):
 * ```
 * <configDir>/plugins/installed_plugins.json
 *   { "version": 2, "plugins": { "<短名>@<marketplace>": [ { installPath, ... } ] } }
 * <installPath>/skills/<skill>/SKILL.md
 * ```
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SkillAvailability } from '../types.js';

/**
 * claude 的設定目錄。engine spawn 子程序時會繼承 env,所以這裡用同一份判斷 ——
 * 檢查的必須是「子程序等一下會讀到的那個目錄」。
 */
export function resolveClaudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.CLAUDE_CONFIG_DIR?.trim();
  if (explicit) return explicit;
  return join(env.HOME?.trim() || homedir(), '.claude');
}

const ok: SkillAvailability = { available: true, reason: '' };
const no = (reason: string): SkillAvailability => ({ available: false, reason });

// 安裝目錄底下 `skills/<任一>/SKILL.md` 至少有一個。
// (刻意用行註解:路徑裡的 `*` 加斜線會提早關掉區塊註解。)
function hasInstalledSkills(installPath: string): boolean {
  const skillsDir = join(installPath, 'skills');
  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch {
    return false;
  }
  return entries.some((name) => existsSync(join(skillsDir, name, 'SKILL.md')));
}

export interface SkillCheckerOpts {
  /** 覆寫設定目錄(測試用)。 */
  configDir?: string;
  /**
   * 子程序的工作目錄(engine 傳 root)。claude 也讀那裡的 `.claude/settings.json` 與
   * `.claude/settings.local.json`,專案層可以 enable / disable plugin。
   */
  projectDir?: string;
}

function readEnabledPlugins(path: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'))?.enabledPlugins;
    return v && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined; // 沒有這個檔或壞掉:這一層不表態
  }
}

/**
 * `<短名>@<marketplace>` 最後是不是 enable。claude 依 user → project → project-local 的順序合併,
 * 後面的蓋前面的;**哪一層都沒寫 = 沒 enable**(marketplace 重裝後掉的正是這個)。
 */
function isEnabled(key: string, layers: Array<Record<string, unknown> | undefined>): boolean {
  let value: unknown;
  for (const layer of layers) if (layer && key in layer) value = layer[key];
  return value === true;
}

/**
 * 建一個 skill 檢查器。
 *
 * **只驗到「這個 plugin 註冊了,而且安裝目錄裡真的有 skill 檔」。** 不驗特定的
 * skill 檔路徑,因為那個對應關係不是慣例:例如 prometheus plugin 的檔案在
 * `skills/query/SKILL.md`,推不出來。要那種精度的宿主自己注入 `checkSkill`
 * —— 那正是那個注入點存在的理由。
 *
 * 這樣仍然擋得住真正常見的失敗:plugin 根本沒註冊、或註冊了但安裝目錄是空的
 * (升級留下的殘骸)。
 */
export function createSkillChecker(o: SkillCheckerOpts = {}): (plugin: string) => SkillAvailability {
  const configDir = o.configDir ?? resolveClaudeConfigDir();
  const registryPath = join(configDir, 'plugins', 'installed_plugins.json');

  // registry 不常變,但 marketplace 重裝可能在宿主程序跑著的時候發生 ——
  // 用 mtime 當 cache key,檔案一改就自動失效重讀。
  let cache: { mtimeMs: number; plugins: Record<string, unknown> } | undefined;

  function load(): Record<string, unknown> | null {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(registryPath).mtimeMs;
    } catch {
      return null;
    }
    if (cache?.mtimeMs === mtimeMs) return cache.plugins;
    try {
      const parsed = JSON.parse(readFileSync(registryPath, 'utf8'));
      const plugins = (parsed?.plugins ?? {}) as Record<string, unknown>;
      cache = { mtimeMs, plugins };
      return plugins;
    } catch {
      // 壞掉的 registry 當成「查不到」,不要讓一個壞 JSON 炸掉整個 engine。
      return null;
    }
  }

  return function checkSkill(plugin: string): SkillAvailability {
    const plugins = load();
    if (!plugins) return no(`讀不到 ${registryPath}`);

    // key 的形狀是 `<短名>@<marketplace>`,而 manifest 只寫短名 —— 同一個短名
    // 理論上可能來自不同 marketplace,任一個裝好了就算數。
    const matches = Object.entries(plugins)
      .filter(([key]) => key === plugin || key.startsWith(`${plugin}@`));
    if (matches.length === 0) return no(`plugin "${plugin}" 未註冊`);

    // 裝了但沒 enable,子程序一樣叫不到 —— 這是 CLAUDE.md 記過的換機雷(重裝後掉 enable)。
    const layers = [
      readEnabledPlugins(join(configDir, 'settings.json')),
      ...(o.projectDir ? [
        readEnabledPlugins(join(o.projectDir, '.claude', 'settings.json')),
        readEnabledPlugins(join(o.projectDir, '.claude', 'settings.local.json')),
      ] : []),
    ];
    const enabled = matches.filter(([key]) => isEnabled(key, layers));
    if (enabled.length === 0) {
      return no(`plugin "${plugin}" 裝了但沒有 enable —— 在 ${join(configDir, 'settings.json')} 的 enabledPlugins 把 `
        + `"${matches[0]![0]}" 設成 true`);
    }

    const paths: string[] = [];
    for (const [, value] of enabled) {
      for (const entry of Array.isArray(value) ? value : [value]) {
        const installPath = (entry as any)?.installPath;
        if (typeof installPath === 'string') paths.push(installPath);
      }
    }
    if (paths.length === 0) return no(`plugin "${plugin}" 註冊了但沒有安裝路徑`);

    // 註冊了卻找不到 skill 檔 = 半殘安裝(升級後留下的空目錄就是這樣)。
    // 這種狀態跟「沒裝」對子程序的後果一樣,所以一樣要擋。
    if (!paths.some(hasInstalledSkills)) {
      return no(`plugin "${plugin}" 註冊了但安裝目錄沒有 skill 檔(${paths[0]})`);
    }
    return ok;
  };
}
