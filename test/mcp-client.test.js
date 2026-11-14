/**
 * @file test/mcp-client.test.js
 * @module test/mcp-client
 * @purpose The MCP client: the handshake over stdio and over HTTP, the list of the tools,
 *          the call of a tool, the names of the proxy, and the servers that do not come up.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createMcpClient, McpError, toolText, CLIENT_PROTOCOL_VERSIONS } from '../src/client/mcp.js';
import { startNodeServer } from '../src/client/node.js';
import { createFetchTransport } from '../src/client/fetch.js';
import { createHttpTransport, mcpUrl } from '../src/client/http.js';
import {
  normalizeServer,
  proxyToolName,
  splitProxyToolName,
  proxyToolDefinition,
  connectServer,
  connectServers,
} from '../src/client/proxy.js';
import { createMcpServer, startHttpServer } from '../src/server/mcp.js';

/** A tiny MCP server that speaks the protocol over stdio. */
const FAKE_SERVER = `
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf('\\n');
    if (index < 0) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    const answer = handle(message);
    if (answer) process.stdout.write(JSON.stringify(answer) + '\\n');
  }
});
function handle(message) {
  const id = message.id;
  if (message.method === 'initialize') {
    return { jsonrpc: '2.0', id, result: { protocolVersion: message.params.protocolVersion, capabilities: {}, serverInfo: { name: 'fake', version: '1.0.0' } } };
  }
  if (message.method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: [{ name: 'echo', description: 'Echo the text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }] } };
  }
  if (message.method === 'tools/call') {
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'echo: ' + message.params.arguments.text }], isError: false } };
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'There is no method named ' + message.method } };
}
`;

/**
 * The path of a fake MCP server.
 * @returns {Promise<{ file: string, dir: string }>}
 */
async function fakeServer() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-serve-client-'));
  const file = path.join(dir, 'fake-mcp.mjs');
  await writeFile(file, FAKE_SERVER, 'utf8');
  return { file, dir };
}

test('the client needs a transport with a send method', () => {
  assert.throws(() => createMcpClient({}), /transport/);
});

test('the versions of the protocol are known', () => {
  assert.deepEqual([...CLIENT_PROTOCOL_VERSIONS], ['2025-06-18', '2025-03-26', '2024-11-05']);
});

test('the client speaks with a server over stdio', async () => {
  const { file } = await fakeServer();
  const child = await startNodeServer({ command: process.execPath, args: [file] });
  try {
    const client = createMcpClient({ transport: child.transport });
    const handshake = await client.initialize();
    assert.equal(handshake.serverInfo.name, 'fake');
    const tools = await client.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'echo');
    const answer = await client.callTool('echo', { text: 'hi' });
    assert.equal(toolText(answer), 'echo: hi');
  } finally {
    await child.close();
  }
});

test('the error of the server becomes an exception of the client', async () => {
  const { file } = await fakeServer();
  const child = await startNodeServer({ command: process.execPath, args: [file] });
  try {
    const client = createMcpClient({ transport: child.transport });
    await assert.rejects(() => client.request('nope/nope'), (error) => {
      assert.equal(error instanceof McpError, true);
      assert.equal(error.code, -32601);
      return true;
    });
  } finally {
    await child.close();
  }
});

test('the server that dies takes the waiting request with it', async () => {
  const child = await startNodeServer({ command: process.execPath, args: ['-e', 'process.exit(1)'] });
  await assert.rejects(() => child.transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' }), /stopped/);
  await child.close();
});

test('the client speaks with a server over HTTP', async () => {
  const handle = await startHttpServer({ server: createMcpServer({}), port: 0, token: 'secret' });
  try {
    const transport = createHttpTransport({ url: handle.url, token: 'secret' });
    const client = createMcpClient({ transport });
    const handshake = await client.initialize();
    assert.equal(handshake.serverInfo.name, 'ai-serve');
    const tools = await client.listTools();
    assert.ok(tools.length > 0);
  } finally {
    await handle.close();
  }
});

test('the client of HTTP refuses a request without the token', async () => {
  const handle = await startHttpServer({ server: createMcpServer({}), port: 0, token: 'secret' });
  try {
    const transport = createFetchTransport({ url: handle.url });
    await assert.rejects(() => transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' }), /token|401/i);
  } finally {
    await handle.close();
  }
});

test('the url of the endpoint comes from the record of the server', () => {
  assert.equal(mcpUrl({ httpURL: 'http://127.0.0.1:1234' }), 'http://127.0.0.1:1234/mcp');
  assert.equal(mcpUrl({ url: 'ws://127.0.0.1:1234' }), 'http://127.0.0.1:1234/mcp');
  assert.throws(() => mcpUrl(null), /record/);
});

test('the entry of a server is normalized', () => {
  const out = normalizeServer({ name: ' fs ', command: 'node', args: ['a.js'], env: { X: '1' } });
  assert.equal(out.name, 'fs');
  assert.equal(out.transport, 'stdio');
  assert.deepEqual(out.args, ['a.js']);
  assert.deepEqual(out.env, { X: '1' });
  assert.equal(out.enabled, true);
});

test('the entry of a server without a command and without a url is refused', () => {
  assert.throws(() => normalizeServer({ name: 'broken' }), /command or a url/);
});

test('the entry of a server without a name gets one', () => {
  assert.equal(normalizeServer({ url: 'http://127.0.0.1:1/mcp' }, 2).name, 'server3');
});

test('the name of a tool of an external server carries its server', () => {
  assert.equal(proxyToolName('fs', 'read_file'), 'fs__read_file');
  assert.deepEqual(splitProxyToolName('fs__read_file'), { server: 'fs', tool: 'read_file' });
  assert.equal(splitProxyToolName('read_file'), null);
  assert.equal(splitProxyToolName('__read_file'), null);
});

test('the description of a tool of an external server keeps the schema', () => {
  const out = proxyToolDefinition('fs', { name: 'read_file', description: 'Read a file.', inputSchema: { type: 'object', properties: {} } });
  assert.equal(out.name, 'fs__read_file');
  assert.equal(out.server, 'fs');
  assert.equal(out.tool, 'read_file');
  assert.equal(out.parameters.type, 'object');
});

test('the proxy connects to a server over stdio', async () => {
  const { file } = await fakeServer();
  const server = await connectServer({ name: 'fake', command: process.execPath, args: [file] });
  try {
    assert.equal(server.name, 'fake');
    assert.equal(server.tools.length, 1);
    const answer = await server.client.callTool('echo', { text: 'hello' });
    assert.equal(toolText(answer), 'echo: hello');
  } finally {
    await server.close();
  }
});

test('the proxy collects the tools of every server', async () => {
  const { file } = await fakeServer();
  const out = await connectServers([{ name: 'fake', command: process.execPath, args: [file] }]);
  try {
    assert.equal(out.errors.length, 0);
    assert.equal(out.tools.length, 1);
    assert.equal(out.tools[0].name, 'fake__echo');
  } finally {
    await out.close();
  }
});

test('the proxy does not stop at a server that does not come up', async () => {
  const { file } = await fakeServer();
  const out = await connectServers([
    { name: 'broken', command: process.execPath, args: ['-e', 'process.exit(1)'] },
    { name: 'fake', command: process.execPath, args: [file] },
  ]);
  try {
    assert.equal(out.errors.length, 1);
    assert.equal(out.errors[0].name, 'broken');
    assert.equal(out.tools.length, 1);
    assert.equal(out.tools[0].name, 'fake__echo');
  } finally {
    await out.close();
  }
});
