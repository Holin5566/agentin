import { z } from 'zod/v4';

/** Balanced `{...}` or `[...]` starting at `start`, ignoring brackets inside strings; undefined if it never closes. */
function balanced(text: string, start: number): string | undefined {
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth++;
    else if ((char === '}' || char === ']') && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}

function* candidates(text: string): Generator<string> {
  yield text.trim();
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{' && text[start] !== '[') continue;
    const json = balanced(text, start);
    if (json) yield json;
  }
}

/**
 * First JSON value in model output that satisfies `schema`, tolerating surrounding prose and code fences.
 * The schema decides which candidate counts, so nested objects are not mistaken for the result.
 * Throws when nothing matches; the Engine reports that as an `output` error.
 */
export function parseJsonOutput<S extends z.ZodType>(text: string, schema: S): { json: string; data: z.output<S> } {
  let issue: z.ZodError | undefined;
  for (const json of candidates(text)) {
    let value: unknown;
    try { value = JSON.parse(json); } catch { continue; }
    const parsed = schema.safeParse(value);
    if (parsed.success) return { json, data: parsed.data };
    issue ??= parsed.error;
  }
  throw new Error(issue ? `output does not match schema: ${z.prettifyError(issue)}` : 'output contains no JSON value');
}
