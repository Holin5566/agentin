/**
 * 找出 JSON 文字裡重複的物件 key。`JSON.parse` 對重複 key 是「後者勝」且不報錯,manifest 裡
 * 複製貼上一行卻忘了改 id,就會靜默把前一條蓋掉(例如某個 tool id 指到另一個上游工具)。
 *
 * 只在 `JSON.parse` 成功之後呼叫,所以輸入一定是合法 JSON,掃描器不必處理語法錯誤。
 * 回傳每個重複 key 的路徑(`tools.browser-click`、`a.b[].c`)。
 */
export function duplicateKeys(text: string): string[] {
  type Frame =
    | { kind: 'obj'; path: string; keys: Set<string>; expectKey: boolean; lastKey: string }
    | { kind: 'arr'; path: string };
  const found: string[] = [];
  const stack: Frame[] = [];
  let i = 0;

  const readString = (): string => {
    const start = i;
    for (i++; text[i] !== '"'; i++) if (text[i] === '\\') i++;
    i++;
    return JSON.parse(text.slice(start, i));
  };
  const join = (path: string, key: string) => (path ? `${path}.${key}` : key);

  while (i < text.length) {
    const ch = text[i];
    const top = stack.at(-1);
    if (ch === '"') {
      if (top?.kind === 'obj' && top.expectKey) {
        const key = readString();
        if (top.keys.has(key)) found.push(join(top.path, key));
        top.keys.add(key);
        top.lastKey = key;
        top.expectKey = false;
      } else {
        readString();
      }
      continue;
    }
    if (ch === '{' || ch === '[') {
      const path = !top ? '' : top.kind === 'obj' ? join(top.path, top.lastKey) : `${top.path}[]`;
      stack.push(ch === '{' ? { kind: 'obj', path, keys: new Set(), expectKey: true, lastKey: '' } : { kind: 'arr', path });
    } else if (ch === '}' || ch === ']') {
      stack.pop();
    } else if (ch === ',' && top?.kind === 'obj') {
      top.expectKey = true;
    }
    i++;
  }
  return found;
}
