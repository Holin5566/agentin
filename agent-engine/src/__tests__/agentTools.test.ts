import { expect, it } from 'vitest';
import { collectTools } from '../agents/tools.js';
import { defineAgent, normalizeAgent } from '../agents/manifest.js';
import { defineTool } from 'mcp-hub';
import { claudeCli } from '../runtimes/claudeCli.js';
import { createVercelAiCli } from '../runtimes/vercelAiCli.js';
const jira = defineTool({ id: 'jira-get', serverId: 'jira', toolName: 'get_issue' });
it('preserves objects and collects only routes needed by the current agent', () => {
  const reader = defineAgent({ id: 'reader', tools: [jira] });
  expect(reader.tools).toEqual([jira]);
  expect(normalizeAgent(reader).tools).toEqual(['jira-get']);
  expect(collectTools([reader], claudeCli)).toEqual([jira]);
  expect(collectTools([defineAgent({ id: 'plain', tools: [] })], claudeCli)).toBeUndefined();
  expect(reader.tools).toEqual([jira]);
});
it('deduplicates identical routes and rejects conflicting definitions', () => {
  const first = defineAgent({ id: 'first', tools: [jira] });
  expect(collectTools([first, first], claudeCli)).toEqual([jira]);
  const second = defineAgent({ id: 'second', tools: [{ ...jira, toolName: 'other' }] });
  expect(() => collectTools([first, second], claudeCli)).toThrow('conflicting tool');
});
it('gets filesystem routes from the adapter when required', () => {
  const runtime = createVercelAiCli({ baseUrl: 'http://localhost:1234' });
  const agent = defineAgent({ id: 'reader', tools: [jira], capabilities: { filesystem: 'read-only', shell: false } });
  expect(collectTools([agent], runtime)?.map(t => t.id)).toEqual(['jira-get', 'fs-read_file', 'fs-list_dir', 'fs-glob', 'fs-grep']);
  expect(collectTools([agent], claudeCli)).toEqual([jira]);
});
