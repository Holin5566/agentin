import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Recorded } from './fakeOpenAi.js';

/** 本機假的 Anthropic Messages API(`POST /v1/messages`,SSE)。事件格式照真實 API。 */
export type AnthropicReply =
  | { kind: 'text'; text: string; usage?: { input: number; output: number } }
  | { kind: 'call'; name: string; args: string }
  | { kind: 'http'; status: number; message: string };

const sse = (events: [string, object][]) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
const start = (usage = { input: 5, output: 1 }) => ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input, output_tokens: usage.output } } }] as [string, object];
const stop = (reason: string, out: number): [string, object][] => [
  ['message_delta', { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: out } }],
  ['message_stop', { type: 'message_stop' }],
];

export async function startFakeAnthropic(reply: (n: number, body: any) => AnthropicReply): Promise<{
  /** 含 `/v1`:當 `baseUrl` 傳給 adapter。 */
  url: string;
  requests: (Recorded & { path: string })[];
  close: () => Promise<void>;
}> {
  const requests: (Recorded & { path: string })[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ headers: req.headers, body, path: req.url ?? '' });
      const r = reply(requests.length - 1, body);
      if (r.kind === 'http') {
        res.writeHead(r.status, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: r.message } }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (r.kind === 'text') {
        res.end(sse([
          start(r.usage),
          ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: r.text } }],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          ...stop('end_turn', r.usage?.output ?? 2),
        ]));
      } else {
        res.end(sse([
          start(),
          ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: r.name, input: {} } }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: r.args } }],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          ...stop('tool_use', 8),
        ]));
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
