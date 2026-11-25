import { describe, expect, it } from 'vitest';
import { mcpChildEnv } from '../runtimes/vercelAi/mcpEnv.js';

describe('mcpChildEnv', () => {
  const parent = { LANG: 'zh_TW.UTF-8', TMPDIR: '/tmp/x', VERCEL_AI_API_KEY: 'sk-1', ANTHROPIC_API_KEY: 'sk-2', PATH: '/usr/bin' };

  it('只帶無害變數;金鑰與其他變數不繼承', () => {
    expect(mcpChildEnv(undefined, parent)).toEqual({ LANG: 'zh_TW.UTF-8', TMPDIR: '/tmp/x' });
  });

  it('設定檔明列的值照給,且優先於白名單', () => {
    expect(mcpChildEnv({ TMPDIR: '/custom', JIRA_TOKEN: 't' }, parent)).toEqual({ LANG: 'zh_TW.UTF-8', TMPDIR: '/custom', JIRA_TOKEN: 't' });
  });

  it('父環境沒有的白名單變數不會變成 undefined 字串', () => {
    expect(mcpChildEnv(undefined, {})).toEqual({});
  });
});
