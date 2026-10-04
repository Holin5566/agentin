import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../runtimes/vercelAi/systemPrompt.js';

const day = new Date(2026, 9, 2, 15, 0); // 本地時間 2026-10-02

describe('buildSystemPrompt', () => {
  it('帶今天的日期、回答語言、最後必須有文字回答', () => {
    const s = buildSystemPrompt({ now: day, toolNames: [] });
    expect(s).toContain('Today is 2026-10-02.');
    expect(s).toMatch(/language of the user/);
    expect(s).toMatch(/plain-text answer/);
  });

  it('有工具:工具出錯 / 被拒 / 找不到時不要猜、不要繞過,直接說;沒有工具:沒有這條,改成「答不出來就說」', () => {
    expect(buildSystemPrompt({ now: day, toolNames: ['get_weather'] })).toMatch(/do not guess other inputs or work around it/);
    const none = buildSystemPrompt({ now: day, toolNames: [] });
    expect(none).not.toMatch(/work around/);
    expect(none).toMatch(/cannot answer/);
  });

  it('檔案路徑規則只在有 fs 工具時才帶(fs-xxx 或 fs_xxx)', () => {
    expect(buildSystemPrompt({ now: day, toolNames: ['get_weather'] })).not.toContain('File tools');
    expect(buildSystemPrompt({ now: day, toolNames: ['fs-read_file', 'fs-grep'] })).toContain('relative to the project root');
    expect(buildSystemPrompt({ now: day, toolNames: ['fs_read_file'] })).toContain('File tools');
  });

  it('精簡:最長的情況也在 900 字元內(每個 take 都會帶,token 成本要小)', () => {
    expect(buildSystemPrompt({ now: day, toolNames: ['fs-read_file'] }).length).toBeLessThan(900);
  });
});
