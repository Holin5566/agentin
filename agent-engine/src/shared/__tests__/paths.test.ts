import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PACKAGE_ROOT, PROJECT_ROOT } from '../paths.js';

/**
 * 這兩個根目錄分開的理由是「裝成別人的相依時還要對」,而那個情境在本地跑不出來。
 * 能驗的是它的**必要條件**:PACKAGE_ROOT 由檔案位置推出(不看 cwd 也不看 env),
 * 且真的指到帶著 package.json 的那棵樹。
 */
describe('paths', () => {
  it('PACKAGE_ROOT 指到帶 package.json 的目錄', () => {
    expect(existsSync(join(PACKAGE_ROOT, 'package.json'))).toBe(true);
  });

  it('PACKAGE_ROOT 不受 AGENT_ENGINE_ROOT 影響 —— 它是套件位置,不是專案位置', async () => {
    const before = PACKAGE_ROOT;
    process.env.AGENT_ENGINE_ROOT = '/nonexistent/somewhere-else';
    try {
      // 兩個常數都在載入時求值,所以要重載模組才看得出差別。
      vi.resetModules();
      const reloaded = await import('../paths.js');
      expect(reloaded.PACKAGE_ROOT).toBe(before);
      // 對照組:PROJECT_ROOT 確實跟著 env 走,證明重載有生效。
      expect(reloaded.PROJECT_ROOT).toBe('/nonexistent/somewhere-else');
    } finally {
      delete process.env.AGENT_ENGINE_ROOT;
      vi.resetModules();
    }
  });

  it('gateway 入口從 mcp-hub package 解析,不跟著 PROJECT_ROOT 走', async () => {
    // 這是原本的 bug:兩者在開發時剛好相等,所以合併成一個變數也測得過。
    // 驗「路徑怎麼算」而不是「檔案在不在」—— 後者會讓這條測試依賴先跑過 build。
    const { GATEWAY_ENTRY } = await import('../../run/gateway.js');
    expect(GATEWAY_ENTRY).toBe(join(dirname(require.resolve('mcp-hub/package.json')), 'dist', 'bin', 'entry.js'));
    expect(GATEWAY_ENTRY).not.toContain(join(PACKAGE_ROOT, 'dist'));

    process.env.AGENT_ENGINE_ROOT = '/nonexistent/somewhere-else';
    try {
      vi.resetModules();
      const reloaded = await import('../../run/gateway.js');
      expect(reloaded.GATEWAY_ENTRY).toBe(GATEWAY_ENTRY);
      expect(reloaded.GATEWAY_ENTRY).not.toContain('somewhere-else');
    } finally {
      delete process.env.AGENT_ENGINE_ROOT;
      vi.resetModules();
    }
  });
});
