// serveBuiltinStdio 的 fixture:用 build 產物起一台只有兩個工具的 stdio server。
const { join } = require('node:path');
const { serveBuiltinStdio, ToolFailure } = require(join(__dirname, '..', '..', '..', 'dist', 'index.js'));

serveBuiltinStdio([
  {
    name: 'echo',
    description: 'echo back',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    execute: async (args) => `echoed: ${args.text}`,
  },
  {
    name: 'fail',
    description: 'always fails',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => { throw new ToolFailure('expected failure', 'detail here'); },
  },
], { name: 'fixture-builtin' });
