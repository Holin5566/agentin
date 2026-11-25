import { describe, expect, it, vi } from 'vitest';
import { openGateway, ToolCallFailed } from '../index.js';
import type { BuiltinTool } from '../index.js';

const schema = { type: 'object' as const, properties: { count: { type: 'integer', minimum: 1 } }, required: ['count'], additionalProperties: false };
async function setup(execute: BuiltinTool['execute']) {
  return openGateway({
    tools: ['render'], log: () => {},
    catalog: { servers: [{ id: 'host', transport: 'in-memory' }], tools: [{ id: 'render', serverId: 'host', toolName: 'render' }] },
    builtinTools: [{ name: 'render', description: 'render result', inputSchema: schema, execute }],
  });
}

describe('public tool contract', () => {
  it('lists schemas and preserves image, structured content and metadata', async () => {
    const result = { content: [{ type: 'image' as const, data: 'YWJj', mimeType: 'image/png' }], structuredContent: { count: 2 }, _meta: { trace: 'x' } };
    const hub = await setup(async () => result);
    try {
      expect(await hub.list()).toEqual([{ id: 'render', description: 'render result', inputSchema: schema }]);
      expect(await hub.callResult('render', { count: 2 })).toEqual({ ...result, isError: false });
      await expect(hub.callResult('hidden', {})).rejects.toMatchObject({ kind: 'denied' });
    } finally { await hub.close(); }
  });

  it('rejects invalid arguments before executing host code', async () => {
    const execute = vi.fn(async () => 'ok');
    const hub = await setup(execute);
    try {
      for (const args of [{}, { count: '2' }, { count: 0 }, { count: 2, extra: true }]) {
        const result = await hub.callResult('render', args);
        expect(result.isError).toBe(true);
      }
      expect(execute).not.toHaveBeenCalled();
      await expect(hub.call('render', {})).rejects.toBeInstanceOf(ToolCallFailed);
      expect(await hub.call('render', { count: 2 })).toBe('ok');
      expect(execute).toHaveBeenCalledTimes(1);
    } finally { await hub.close(); }
  });

  it('keeps full tool failures and prevents pre-cancelled execution', async () => {
    const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'failed' }], isError: true, structuredContent: { retry: false } }));
    const hub = await setup(execute);
    try {
      expect(await hub.callResult('render', { count: 2 })).toMatchObject({ isError: true, structuredContent: { retry: false } });
      await expect(hub.callResult('render', { count: 2 }, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
      expect(execute).toHaveBeenCalledTimes(1);
      await hub.close();
      await expect(hub.callResult('render', { count: 2 })).rejects.toThrow(/closed/);
    } finally { await hub.close(); }
  });
});
