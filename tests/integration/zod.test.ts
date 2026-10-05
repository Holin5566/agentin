import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { defineAgent, defineTool, ToolFailure } from '../../src/index.js';
import { openToolBridge } from '../../src/tools/bridge.js';

const context = { agent: 'test', runId: 'test', signal: new AbortController().signal };

describe('Zod function tools', () => {
  it('infers parsed arguments and preserves defaults and transforms through agent snapshots', async () => {
    const tool = defineTool({
      id: 'greet', description: 'greet',
      inputSchema: z.strictObject({ name: z.string().transform(value => value.length), count: z.number().default(2) }),
      execute: async ({ name, count }) => {
        const typed: number = name;
        // @ts-expect-error transformed name is a number
        const wrong: string = name;
        void wrong;
        return String(typed * count);
      },
    });
    const agent = defineAgent({ id: 'test', instructions: '', tools: [tool] });
    expect(await (agent.tools[0] as typeof tool).execute({ name: 'Ada' }, context)).toBe('6');
    expect(tool.inputSchema.properties).toMatchObject({ name: { type: 'string' } });
    expect(tool.inputSchema.required).toEqual(['name']);
  });

  it('returns host-only async refinement failures as MCP tool errors without executing', async () => {
    const execute = vi.fn(async ({ name }: { name: string }) => name);
    const tool = defineTool({ id: 'greet', description: 'greet',
      inputSchema: z.strictObject({ name: z.string().refine(async value => value !== 'blocked', 'name is blocked') }), execute });
    const bridge = await openToolBridge([tool], 'test', context.signal);
    try {
      const response = await fetch(`${bridge.server.env!.AGENTIN_BRIDGE_URL}/call`, {
        method: 'POST', headers: { authorization: `Bearer ${bridge.server.env!.AGENTIN_BRIDGE_TOKEN}` },
        body: JSON.stringify({ id: 'greet', args: { name: 'blocked' } }),
      });
      expect(await response.json()).toMatchObject({ isError: true });
      expect(execute).not.toHaveBeenCalled();
      await expect(tool.execute({ name: 'allowed', extra: true }, context)).rejects.toBeInstanceOf(ToolFailure);
      expect(await tool.execute({ name: 'allowed' }, context)).toBe('allowed');
    } finally { await bridge.close(); }
  });

  it('rejects non-object and unrepresentable schemas during definition', () => {
    expect(() => defineTool({ id: 'bad', description: '', inputSchema: z.string(), execute: async () => '' })).toThrow('invalid function tool');
    expect(() => defineTool({ id: 'bad', description: '', inputSchema: z.object({ date: z.date() }), execute: async () => '' })).toThrow('cannot be represented');
  });
});
