/**
 * 讀取 catalog 並驗證允許的工具清單，供程式與 CLI 入口共用。
 * 允許清單由呼叫端算好傳進來 —— hub 不知道 agent 是什麼。
 * 只有 scopeUnrestricted() 允許全部工具。
 */
import { loadCatalog, resolveAllow, type Catalog } from './load.js';

export interface Scope {
  catalog: Catalog;
  /** undefined = 不限制(只有 `scopeUnrestricted()` 會給)。 */
  allow?: string[];
  /** 給 log 用的一行描述。 */
  label: string;
}

/** 允許清單直接指定(`--tools` / `openGateway({ tools })`)。仍然驗每個 id 真的有宣告。 */
export function scopeForTools(ids: string[], catalog: Catalog = loadCatalog()): Scope {
  const allow = resolveAllow(catalog, ids);
  return { catalog, allow, label: `allow=${allow.join(',') || '(none)'}` };
}

/** 不限制。只有 `--all-tools` 走得到,而且必須明寫。 */
export function scopeUnrestricted(catalog: Catalog = loadCatalog()): Scope {
  return { catalog, label: '(unrestricted)' };
}
