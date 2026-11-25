/**
 * 兩個根,別搞混:
 *
 * `PROJECT_ROOT` —— 宿主的專案根,`manifests/mcp-servers/` 在這裡找。由
 * `MCP_HUB_ROOT` 指定;沒設就讀 `AGENT_ENGINE_ROOT`(engine 拉起 gateway 時設的是
 * 這個),兩者都沒有才用 cwd。
 *
 * `PACKAGE_ROOT` —— 這包程式自己的安裝位置,build 產物(`dist/bin/entry.js`)在這裡。
 * 由檔案位置推出,不看 cwd 也不看 env。
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const PROJECT_ROOT = resolve(
  process.env.MCP_HUB_ROOT ?? process.env.AGENT_ENGINE_ROOT ?? process.cwd(),
);

function findPackageRoot(from: string): string {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) throw new Error(`找不到 mcp-hub 的 package.json(從 ${from} 一路往上)`);
    dir = up;
  }
}

export const PACKAGE_ROOT = findPackageRoot(__dirname);
