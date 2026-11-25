#!/usr/bin/env node
/**
 * 唯讀檔案工具的 stdio MCP server(見 `tools/fsRead.ts`)。在 `manifests/mcp-servers/fs-readonly.json`
 * 宣告成一台上游,gateway 就能把 `fs_*` 工具交給沒有原生檔案工具的 runtime。
 *
 * 根目錄:`FS_READ_ROOTS`(依平台分隔符,例 `a:b`),沒設就用 `AGENT_ENGINE_ROOT`,再沒有才用 cwd。
 * 額外拒絕:`FS_READ_DENY`(逗號分隔的檔名 glob)。
 * 頂層允許清單:`FS_READ_ALLOW_TOP`(逗號分隔的目錄名,例 `repos,domain`)—— 設了就只開放 root 底下這幾個目錄。
 */
import { delimiter } from 'node:path';
import { serveBuiltinStdio } from '../builtin/stdio.js';
import { createFsReadTools } from '../tools/fsRead.js';

const roots = (process.env.FS_READ_ROOTS ?? process.env.AGENT_ENGINE_ROOT ?? process.cwd())
  .split(delimiter).map((s) => s.trim()).filter(Boolean);
const deny = (process.env.FS_READ_DENY ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const allowTop = (process.env.FS_READ_ALLOW_TOP ?? '').split(',').map((s) => s.trim()).filter(Boolean);

serveBuiltinStdio(createFsReadTools({ roots, deny, ...(allowTop.length ? { allowTop } : {}) }), { name: 'fs-readonly' }).catch((e) => {
  process.stderr.write(`[fs-readonly] failed to start: ${e?.message ?? e}\n`);
  process.exitCode = 1;
});
