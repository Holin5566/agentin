import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** 本機假的 OpenAI 相容 server:依「第幾個請求」決定回什麼。 */
export interface Recorded { headers: http.IncomingHttpHeaders; body: any }
export type Reply =
  | { kind: 'text'; text: string; usage?: { prompt: number; completion: number } }
  | { kind: 'call'; name: string; args: string }
  | { kind: 'http'; status: number; message: string }
  /** tool call 送完之後串流裡出現錯誤事件。 */
  | { kind: 'call-then-error'; name: string; args: string; message: string }
  | { kind: 'hang' }
  /** 串流 `chunks` 個思考片段(reasoning_content);`then: 'hang'` = 之後不收尾(模型一直想),`'text'` = 想完回答。 */
  | { kind: 'think'; chunks: number; then: 'hang' | 'text'; text?: string };

const base = { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm' };
const delta = (d: object, fr: string | null = null) => ({ ...base, choices: [{ index: 0, delta: d, finish_reason: fr }] });

function sse(res: http.ServerResponse, chunks: object[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

export async function startFakeOpenAi(reply: (n: number, body: any) => Reply): Promise<{
  url: string;
  requests: Recorded[];
  close: () => Promise<void>;
}> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ headers: req.headers, body });
      const r = reply(requests.length - 1, body);
      switch (r.kind) {
        case 'text':
          return sse(res, [
            delta({ role: 'assistant', content: r.text }),
            delta({}, 'stop'),
            ...(r.usage ? [{ ...base, choices: [], usage: { prompt_tokens: r.usage.prompt, completion_tokens: r.usage.completion, total_tokens: r.usage.prompt + r.usage.completion } }] : []),
          ]);
        case 'call':
          return sse(res, [
            delta({ role: 'assistant', tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name: r.name, arguments: '' } }] }),
            delta({ tool_calls: [{ index: 0, function: { arguments: r.args } }] }),
            delta({}, 'tool_calls'),
          ]);
        case 'call-then-error':
          return sse(res, [
            delta({ role: 'assistant', tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name: r.name, arguments: '' } }] }),
            delta({ tool_calls: [{ index: 0, function: { arguments: r.args } }] }),
            { error: { message: r.message } },
          ]);
        case 'http':
          res.writeHead(r.status, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: r.message } }));
        case 'think': {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          for (let i = 0; i < r.chunks; i++) res.write(`data: ${JSON.stringify(delta(i === 0 ? { role: 'assistant', reasoning_content: 'hmm ' } : { reasoning_content: 'hmm ' }))}\n\n`);
          if (r.then === 'text') {
            res.write(`data: ${JSON.stringify(delta({ content: r.text ?? 'ok' }))}\n\n`);
            res.write(`data: ${JSON.stringify(delta({}, 'stop'))}\n\n`);
            res.write('data: [DONE]\n\n');
            return res.end();
          }
          return; // 一直想,不收尾:等 client 斷線
        }
        case 'hang':
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify(delta({ role: 'assistant', content: 'part' }))}\n\n`);
          return; // 不收尾:等 client 斷線
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
