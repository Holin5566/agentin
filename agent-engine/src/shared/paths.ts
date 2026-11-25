/**
 * 兩個根目錄,刻意分開。
 *
 * `PROJECT_ROOT` —— 宿主的專案根,`manifests/` 在這裡找。由 `AGENT_ENGINE_ROOT`
 * 指定,省略就用目前工作目錄。**這是宿主的東西**:agent 宣告、MCP server 宣告
 * 都是使用這包程式的人寫的。
 *
 * `PACKAGE_ROOT` —— 這包程式自己的安裝位置,build 產物(`dist/`)在這裡。gateway 入口改由 mcp-hub package 提供
 * 找。從本檔位置往上找 `package.json`,所以 vitest 直跑 TS(`src/shared/`)與 tsc
 * 產物(`dist/shared/`)兩種情況都成立。
 *
 * **為什麼不能共用一個變數**:裝成宿主的 node_modules 相依之後,manifests 在宿主的
 * cwd,而 entry.js 在 `node_modules/agent-engine/dist/` —— 一個變數指不到兩個地方。
 * 原本合併成 `RUNNER_DIR` 時,只有「專案根 = 套件根」的開發情境會過,一發布就斷。
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** 宿主專案根。`manifests/` 相對於它。 */
export const PROJECT_ROOT = resolve(process.env.AGENT_ENGINE_ROOT ?? process.cwd());

/**
 * 往上找到第一個有 `package.json` 的目錄。
 *
 * 找不到就炸:靜默退回 cwd 會讓 `GATEWAY_ENTRY` 指到一個剛好存在的別人的 dist,
 * 那比啟動失敗難查得多。
 */
function findPackageRoot(from: string): string {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) throw new Error(`找不到 agent-engine 的 package.json(從 ${from} 一路往上）`);
    dir = up;
  }
}

/** 這包程式的安裝根。build 產物相對於它。 */
export const PACKAGE_ROOT = findPackageRoot(__dirname);
