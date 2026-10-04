// 假的 stdio MCP server:給 runner 的端到端測試當 gateway。
// get_weather → 文字結果;boom → 工具自己回報失敗(isError)。
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

// 測試要確認 runner 收尾時有把我們收掉:把 pid 寫出去。
if (process.env.FAKE_MCP_PIDFILE) require('node:fs').writeFileSync(process.env.FAKE_MCP_PIDFILE, String(process.pid));

// 測試要確認 runner 沒有把自己的環境(含金鑰)傳給我們:把看到的環境變數名稱寫出去。
if (process.env.FAKE_MCP_ENVFILE) require('node:fs').writeFileSync(process.env.FAKE_MCP_ENVFILE, JSON.stringify(process.env));

const server = new Server({ name: 'fake', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'get_weather', description: 'Get weather', inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
    { name: 'boom', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'get_weather') return { content: [{ type: 'text', text: `${req.params.arguments.city}: 27C cloudy` }] };
  if (req.params.name === 'boom') return { isError: true, content: [{ type: 'text', text: 'tool exploded' }] };
  throw new Error(`unknown tool ${req.params.name}`);
});
server.connect(new StdioServerTransport());
