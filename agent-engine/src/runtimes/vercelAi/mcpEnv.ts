/**
 * runner 拉起 gateway(MCP server 子程序)時給它的環境變數。
 *
 * **不繼承 runner 的完整環境**:runner 的環境裡有模型金鑰(`VERCEL_AI_API_KEY`)和宿主繼承來的其他 secret,
 * gateway 底下的 upstream(npx 類 MCP 等)用不到,也不該拿到。跟 `claude -p` 一樣,只給:
 *   1. MCP SDK 預設的安全變數(`PATH` `HOME` `USER`…,transport 自己會疊上去);
 *   2. 一小組無害的語系 / 暫存目錄變數;
 *   3. 設定檔(`--mcp-config`)明確列出的值 —— 工具需要什麼 secret,由 engine 寫進設定檔,不靠繼承。
 */
const HARMLESS = ['LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TZ'] as const;

export function mcpChildEnv(
  explicit: Record<string, string> | undefined,
  parent: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of HARMLESS) {
    const v = parent[k];
    if (typeof v === 'string') out[k] = v;
  }
  return { ...out, ...(explicit ?? {}) };
}
