#!/usr/bin/env node
// MCP server (stdio): gives any MCP client (Claude, Cursor, an agent framework) a private
// NEAR balance. Configure with NPR_NETWORK, NPR_AGENT_KEY (optional), NPR_MAX_PAYMENT and
// NPR_MAX_TOTAL (NEAR; the total this process may spend, fees included).
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createAgentTools, loadAgentKey } from './tools.js';

const { tools } = await createAgentTools({ network: process.env.NPR_NETWORK ?? 'testnet', key: loadAgentKey(), maxPerPayment: process.env.NPR_MAX_PAYMENT ?? '1', maxTotal: process.env.NPR_MAX_TOTAL ?? '1' });
const server = new Server({ name: 'near-privacy-rings', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = tools.find((t) => t.name === req.params.name);
  try {
    if (!tool) throw new Error(`unknown tool ${req.params.name}`);
    return { content: [{ type: 'text', text: JSON.stringify(await tool.run(req.params.arguments ?? {})) }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: String(e.message ?? e) }] };
  }
});
await server.connect(new StdioServerTransport());
