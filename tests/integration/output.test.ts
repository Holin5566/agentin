import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { createAgentin, createMemoryStore, defineAgent } from '../../src/index.js';
import type { SpawnRuntime } from '../../src/index.js';
import { parseJsonOutput } from '../../src/output.js';

function printing(text: string): SpawnRuntime {
  return {
    name: 'print', capabilities: { skills: false, nativeTools: false, filesystemPolicy: 'tool-list', maxSteps: false },
    command: () => ({ file: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(text)})`] }),
  };
}
function setup(text: string, store = createMemoryStore()) {
  return createAgentin({ agents: [defineAgent({ id: 'judge', instructions: '' })], runtimes: { local: printing(text) }, defaultRuntime: 'local', artifacts: store });
}
const verdict = z.strictObject({ pass: z.boolean(), score: z.number().transform(value => value * 10) });

describe('run output schema', () => {
  it('extracts JSON from prose, infers data type and commits the JSON text', async () => {
    const store = createMemoryStore();
    const app = setup('Thinking {"note":"nested"}.\n```json\n{"pass":true,"score":0.5}\n```\nDone.', store);
    try {
      const result = await app.run({ agent: 'judge', input: 'grade', output: verdict });
      expect(result).toMatchObject({ status: 'ok', output: '{"pass":true,"score":0.5}', data: { pass: true, score: 5 } });
      const score: number | undefined = result.data?.score;
      // @ts-expect-error score is a number after transform
      const wrong: string | undefined = result.data?.score;
      void score; void wrong;
      expect(await store.read(result.artifact!)).toBe(result.output);
    } finally { await app.close(); }
  });

  it('applies parseOutput before the schema', async () => {
    const app = setup('RESULT: {"pass":false,"score":1}');
    try {
      const result = await app.run({ agent: 'judge', input: 'grade', output: verdict, parseOutput: raw => raw.replace('RESULT:', '') });
      expect(result.data).toEqual({ pass: false, score: 10 });
    } finally { await app.close(); }
  });

  it('reports mismatches as output errors without data or artifact', async () => {
    const app = setup('{"pass":"yes","score":1}');
    try {
      const result = await app.run({ agent: 'judge', input: 'grade', output: verdict });
      expect(result.status).toBe('error');
      expect(result.error).toMatchObject({ kind: 'output' });
      expect(result.error!.message).toContain('pass');
      expect(result).not.toHaveProperty('data');
      expect(result.artifact).toBeUndefined();
    } finally { await app.close(); }
  });

  it('rejects a non-Zod output option as config', async () => {
    const app = setup('{}');
    try {
      await expect(app.run({ agent: 'judge', input: 'x', output: {} as z.ZodType })).rejects.toMatchObject({ kind: 'config' });
    } finally { await app.close(); }
  });
});

describe('parseJsonOutput', () => {
  it('accepts arrays, ignores brackets inside strings and reports missing JSON', () => {
    expect(parseJsonOutput('list: ["a]", "b"] end', z.array(z.string())).data).toEqual(['a]', 'b']);
    expect(parseJsonOutput('{"wrap":{"pass":true,"score":2}}', z.object({ wrap: z.unknown() })).json).toBe('{"wrap":{"pass":true,"score":2}}');
    expect(parseJsonOutput('{"wrap":{"pass":true,"score":2}}', verdict).data).toEqual({ pass: true, score: 20 });
    expect(() => parseJsonOutput('no json here', verdict)).toThrow('no JSON value');
  });
});
