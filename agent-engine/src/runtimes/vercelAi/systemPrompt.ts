/**
 * runner 給模型的 system 訊息 —— 沒有原生 CLI 的 runtime 要自己補「你在哪、能做什麼」。
 * claude CLI 靠自己的 system prompt 做這件事(工作目錄、日期、工具用法);裸模型什麼都沒有,
 * 只看得到宿主拼好的 prompt 與工具 schema。
 *
 * 刻意**精簡、分區塊、只放通用事實與工具規則**(Anthropic 的 context engineering 建議:最小可行,先測再加):
 *   - 領域背景(產品、站台、輸出格式)是宿主的事,在宿主 prompt 裡,engine 不知道也不該知道。
 *   - 工具清單不必重寫 —— schema 已經隨請求送出;這裡只補「怎麼用」的規則。
 *   - 檔案路徑規則只在真的有 `fs-*` 工具時才帶。
 *
 * 每條規則都對應一個實測過的失敗:
 *   - 被工具擋下後亂試路徑,直到 token 用完;
 *   - 只吐思考、沒有文字回答(`content` 空白)。
 */

export interface SystemPromptInput {
  /** 注入以便測試;預設現在。 */
  now?: Date;
  /** gateway 提供給模型的工具名稱。 */
  toolNames: string[];
}

/** `YYYY-MM-DD`,用執行環境的本地日期(跟宿主看到的「今天」一致)。 */
const localDate = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function buildSystemPrompt({ now = new Date(), toolNames }: SystemPromptInput): string {
  const hasFs = toolNames.some((n) => /^fs[-_]/.test(n));
  const lines = [
    '## Context',
    `- Today is ${localDate(now)}.`,
    // 宿主的 prompt 常是中文、輸出要給中文使用者;不講的話用哪種語言回答由模型自己決定。(預防性規則,沒有對應的實測失敗。)
    '- Reply in the language of the user\'s request.',
    '',
    '## Instructions',
    // 對應實測失敗:推理模型把話全放在思考裡,`content` 只剩空白,take 卻回報成功。(loop 另有補問與判失敗的後盾。)
    '- Finish with a plain-text answer. Never end with only reasoning or an empty message.',
    // 對應實測失敗:工具回「存取被拒 / 找不到」後,模型改試 `repos/x`、`domain/x`… 一個接一個猜路徑,直到 token 用完。
    // 有工具才講這條:沒有工具的回合不會有「工具出錯」,多講只會讓模型困惑。
    toolNames.length > 0
      ? '- If a tool reports an error, access denied or not found, do not guess other inputs or work around it: say plainly that you could not find it or are not permitted, and answer with what you do have.'
      : '- If you cannot answer, say so plainly instead of guessing.',
  ];
  if (hasFs) {
    // 只在真的有 `fs-*` 工具時才帶:路徑規則對沒有檔案工具的 agent 是雜訊。「先用 list/glob 確認名稱」對應的是
    // 模型憑空猜檔案位置而不是先看目錄。
    lines.push(
      '',
      '## File tools',
      '- Paths are relative to the project root; only some top-level directories are readable. Use the list/glob tool to confirm a name before reading.',
    );
  }
  return lines.join('\n');
}
