/**
 * CLI adapter 共用:疊在子程序繼承環境上的變數(`SpawnCommand.env` 格式)。
 *
 * `unsetEnv` 優先 —— 同一個 key 同時被設定與拿掉時,一律拿掉。被要求拿掉的通常是
 * 會讓 CLI 靜默改走計費 API 的金鑰,權限邊界的失敗方向只能往嚴。
 */
export function childEnv(opts: { env?: Record<string, string>; unsetEnv?: string[] }): Record<string, string | undefined> | undefined {
  const unset = Object.fromEntries((opts.unsetEnv ?? []).map((k) => [k, undefined]));
  const merged = { ...opts.env, ...unset };
  return Object.keys(merged).length ? merged : undefined;
}
