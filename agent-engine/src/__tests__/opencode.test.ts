import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createOpenCodeCli } from '../runtimes/opencodeCli.js';
import { createOpenCodeDecoder } from '../runtimes/opencodeStream.js';
import type { RuntimeEvent } from '../types.js';
const row = (type: string, part?: object) => JSON.stringify({ type, part }) + '\n';
function decode(text: string): RuntimeEvent[] {
  const decoder = createOpenCodeDecoder();
  return [...decoder.push(text), ...decoder.finish()];
}
describe('OpenCode JSONL decoder', () => {
  it('handles fragmented completed text and sums per-step usage through delta events', () => {
    const input = row('step_start') + row('text', { id: 't1', text: '你好' }) + row('step_finish', { reason: 'tool-calls', tokens: { input: 4, output: 2 } }) + row('step_start') + row('text', { id: 't2', text: '！' }) + row('step_finish', { reason: 'stop', tokens: { input: 8, output: 3 } });
    const decoder = createOpenCodeDecoder();
    const fragmented = [...input].flatMap(chunk => decoder.push(chunk));
    fragmented.push(...decoder.finish());
    expect(fragmented).toEqual(decode(input));
    expect(fragmented).toContainEqual({ type: 'output', text: '你好！' });
    expect(fragmented.filter(event => event.type === 'usage')).toHaveLength(2);
    expect(fragmented.at(-1)).toEqual({ type: 'stopped', reason: 'end_turn' });
  });
  it('reports tool facts observed at completion and avoids duplicate text and tools', () => {
    const text = row('text', { id: 't', text: 'x' });
    const tool = row('tool_use', { callID: 'c', tool: 'read', state: { status: 'completed', input: { filePath: 'a' }, output: 'result', time: { start: 10, end: 15 } } });
    const events = decode(text + text + tool + tool);
    expect(events.filter(event => event.type === 'text')).toHaveLength(1);
    expect(events.filter(event => event.type === 'tool-start')).toHaveLength(1);
    expect(events).toContainEqual({ type: 'tool-end', toolCallId: 'c', toolId: 'read', ok: true, elapsedMs: 5, output: 'result' });
  });
  it('does not treat tool-calls or an unfinished next step as success', () => {
    expect(decode(row('step_finish', { reason: 'tool-calls' })).at(-1)).toEqual({ type: 'stopped', reason: 'unknown' });
    expect(decode(row('step_finish', { reason: 'stop' }) + row('step_start')).at(-1)).toEqual({ type: 'stopped', reason: 'unknown' });
  });
  it('keeps errors terminal and maps token exhaustion', () => {
    expect(decode(row('error') + row('step_finish', { reason: 'stop' })).at(-1)).toEqual({ type: 'stopped', reason: 'unknown' });
    expect(decode(row('step_finish', { reason: 'length' }).trimEnd()).at(-1)).toEqual({ type: 'stopped', reason: 'max_tokens' });
    expect(decode('noise\n').at(-1)).toEqual({ type: 'stopped', reason: 'unknown' });
  });
});
describe('OpenCode policy mapping', () => {
  it('starts fresh, sends prompts through stdin and denies undeclared native tools', () => {
    const command = createOpenCodeCli().command({ prompt: '- a long prompt' });
    expect(command.stdin).toBe('- a long prompt');
    expect(command.args).toEqual(expect.arrayContaining(['run', '--format', 'json']));
    expect(command.args).not.toContain('--continue');
    const config = JSON.parse(command.env!.OPENCODE_CONFIG_CONTENT!);
    expect(Object.values(config.agent)[0]).toMatchObject({ tools: { '*': false }, permission: { '*': 'deny' } });
    expect(command.env!.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('true');
  });
  it('translates per-take gateway settings without putting credentials in argv', () => {
    const root = mkdtempSync(join(tmpdir(), 'opencode-config-'));
    const file = join(root, 'mcp.json');
    writeFileSync(file, JSON.stringify({ mcpServers: { 'agent-engine-gateway': { command: '/node', args: ['entry.js', '--tools', 'echo'], env: { TOKEN: 'secret' } } } }));
    try {
      const command = createOpenCodeCli({ env: { OPENCODE_CONFIG_CONTENT: 'unsafe' } }).command({ prompt: 'x', mcpConfigPath: file });
      const config = JSON.parse(command.env!.OPENCODE_CONFIG_CONTENT!);
      expect(config.mcp['agent-engine-gateway']).toEqual({ type: 'local', command: ['/node', 'entry.js', '--tools', 'echo'], environment: { TOKEN: 'secret' }, enabled: true });
      expect(Object.values(config.agent)[0]).toMatchObject({ tools: { '*': false, 'agent-engine-gateway_*': true } });
      expect(command.args.join(' ')).not.toContain('secret');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('maps explicit read and shell permissions and rejects workspace writes', () => {
    const adapter = createOpenCodeCli({ model: 'provider/default' });
    const command = adapter.command({ prompt: '', model: 'provider/override', capabilities: { filesystem: 'read-only', shell: true } });
    const config = JSON.parse(command.env!.OPENCODE_CONFIG_CONTENT!);
    expect(Object.values(config.agent)[0]).toMatchObject({ tools: { read: true, glob: true, grep: true, bash: true }, permission: { external_directory: 'deny' } });
    expect(command.args).toContain('provider/override');
    expect(() => adapter.validateCapabilities!({ filesystem: 'workspace-write' })).toThrow(/workspace-write/);
  });
});
