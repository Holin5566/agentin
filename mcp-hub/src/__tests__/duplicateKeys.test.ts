import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCatalog } from '../manifest/load.js';
import { duplicateKeys } from '../manifest/duplicateKeys.js';

describe('duplicateKeys', () => {
  it('找出重複的 key 並給出路徑;不同物件裡同名的 key 不算', () => {
    expect(duplicateKeys('{"a":1,"a":2}')).toEqual(['a']);
    expect(duplicateKeys('{"tools":{"x":"a","y":"b","x":"c"},"x":1}')).toEqual(['tools.x']);
    expect(duplicateKeys('{"list":[{"k":1,"k":2},{"k":3}]}')).toEqual(['list[].k']);
    expect(duplicateKeys('{"a":{"k":1},"b":{"k":1}}')).toEqual([]);
  });

  it('字串值裡的逗號、引號、大括號不影響判斷', () => {
    expect(duplicateKeys('{"a":"x, \\"a\\": {y}","b":"\\\\"}')).toEqual([]);
    expect(duplicateKeys('{"a\\"b":1,"a\\"b":2}')).toEqual(['a"b']);
  });
});

describe('manifest 載入', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
  const load = (file: string, text: string) => {
    dir = mkdtempSync(join(tmpdir(), 'hub-dup-'));
    writeFileSync(join(dir, file), text);
    return () => loadCatalog(dir);
  };

  it('同一個檔裡重複的 tool id 擋下來 —— 不然前一條會被後一條靜默蓋掉', () => {
    expect(load('pw.json', `{"id":"pw","transport":"stdio","command":"x",
      "tools":{"browser-click":"browser_click","browser-click":"browser_type"}}`))
      .toThrow(/pw\.json: 重複的 key "tools\.browser-click"/);
  });

  it('env 的值不是字串就在載入時擋,不等到連線才 TypeError', () => {
    expect(load('s.json', JSON.stringify({ id: 's', transport: 'stdio', command: 'x', env: { MAX: 3 } })))
      .toThrow(/env 的值必須是字串\(MAX\)/);
  });
});
