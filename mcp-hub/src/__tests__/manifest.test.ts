import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalog, resolveAllow, type Catalog } from '../manifest/load.js';

// Direct coverage for manifest/load.ts + scope.ts. The collision-handling across
// upstreams (cross-file duplicate server id and duplicate OUTWARD tool id — the
// tool-name-namespacing safety) and resolveAllow's missing-id error were only
// exercised incidentally before; these pin them.

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mcp-manifest-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const write = (file: string, body: unknown) => writeFileSync(join(dir, file), JSON.stringify(body));

const stdioServer = (id: string, tools: Record<string, string>) => ({
  id, transport: 'stdio', command: 'node', args: ['x.mjs'], tools,
});

describe('loadCatalog — cross-file collisions', () => {
  it('throws on a duplicate server id declared in two files', () => {
    write('a.json', stdioServer('dup', { 'a-echo': 'echo' }));
    write('b.json', stdioServer('dup', { 'b-echo': 'echo' }));
    expect(() => loadCatalog(dir)).toThrow(/duplicate server id "dup"/);
  });

  it('throws on the same OUTWARD tool id declared by two different servers', () => {
    // Both servers expose an outward tool id `search` — the namespacing safety:
    // a caller asking for `search` must not silently hit one upstream or the other.
    write('alpha.json', stdioServer('alpha', { search: 'alpha_search' }));
    write('beta.json', stdioServer('beta', { search: 'beta_search' }));
    expect(() => loadCatalog(dir)).toThrow(/duplicate tool id "search"/);
  });

  it('loads two distinct servers with distinct tools, wiring serverId from the file decl', () => {
    write('alpha.json', stdioServer('alpha', { 'a-search': 'alpha_search' }));
    write('beta.json', stdioServer('beta', { 'b-search': 'beta_search' }));
    const cat: Catalog = loadCatalog(dir);
    expect(cat.servers.map((s) => s.id).sort()).toEqual(['alpha', 'beta']);
    expect(cat.tools.map((t) => t.id).sort()).toEqual(['a-search', 'b-search']);
    expect(cat.tools.find((t) => t.id === 'a-search')!.serverId).toBe('alpha');
    expect(cat.tools.find((t) => t.id === 'a-search')!.toolName).toBe('alpha_search');
    expect(cat.tools.find((t) => t.id === 'b-search')!.serverId).toBe('beta');
    expect(cat.tools.find((t) => t.id === 'b-search')!.toolName).toBe('beta_search');
  });
});

describe('loadCatalog — validation', () => {
  it('rejects an unknown transport', () => {
    write('bad.json', { id: 'x', transport: 'carrier-pigeon', tools: {} });
    expect(() => loadCatalog(dir)).toThrow(/transport 必須是/);
  });

  it('rejects a non-object tools field', () => {
    write('bad.json', { id: 'x', transport: 'stdio', command: 'node', tools: ['nope'] });
    expect(() => loadCatalog(dir)).toThrow(/tools 必須是物件/);
  });

  it('an empty dir yields an empty catalog', () => {
    const cat = loadCatalog(dir);
    expect(cat.servers).toEqual([]);
    expect(cat.tools).toEqual([]);
  });
});

describe('resolveAllow', () => {
  const catalogOf = () => {
    write('alpha.json', stdioServer('alpha', { 'a-search': 'alpha_search', 'a-get': 'alpha_get' }));
    return loadCatalog(dir);
  };

  it('returns the wanted ids when all resolve', () => {
    expect(resolveAllow(catalogOf(), ['a-search', 'a-get'])).toEqual(['a-search', 'a-get']);
  });

  it('throws naming every unknown tool id', () => {
    expect(() => resolveAllow(catalogOf(), ['a-search', 'ghost'])).toThrow(/未定義的 tool id: ghost/);
  });

  it('an empty allow-list resolves to an empty list', () => {
    expect(resolveAllow(catalogOf(), [])).toEqual([]);
  });
});
