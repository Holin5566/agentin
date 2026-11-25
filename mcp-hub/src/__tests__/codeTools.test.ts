import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { defineTool, loadCatalog, resolveAllow } from '../manifest/load.js';

const dir = join(__dirname, 'fixture/manifests/mcp-servers');
const echo = defineTool({ id: 'code-echo', serverId: 'upstream', toolName: 'echo' });

describe('code-defined routes', () => {
  it('replaces JSON tool maps while preserving connection limits and the allowlist', () => {
    const catalog = loadCatalog(dir, [echo]);
    expect(catalog.tools).toEqual([{ ...echo, timeoutMs: 5000, maxTotalTimeoutMs: undefined }]);
    expect(resolveAllow(catalog, ['code-echo'])).toEqual(['code-echo']);
    expect(() => resolveAllow(catalog, ['up-secret'])).toThrow('未定義');
    expect(loadCatalog(dir, []).tools).toEqual([]);
  });
  it('rejects unknown servers and duplicate ids before connecting', () => {
    expect(() => loadCatalog(dir, [{ ...echo, serverId: 'missing' }])).toThrow('unknown server');
    expect(() => loadCatalog(dir, [echo, echo])).toThrow('duplicate tool');
  });
  it('rejects malformed route definitions', () => {
    expect(() => defineTool({ ...echo, toolName: '' })).toThrow('toolName');
    expect(() => defineTool({ ...echo, timeoutMs: -1 })).toThrow('timeoutMs');
    expect(() => defineTool({ ...echo, toolname: 'echo' } as any)).toThrow('unknown field');
  });
});
