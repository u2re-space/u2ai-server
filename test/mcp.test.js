/**
 * @file test/mcp.test.js
 * @module test/mcp
 * @purpose The MCP server: the handshake, the list of the tools, the call of a tool, the
 *          resources, the prompts, the timeout, the cancellation, and the two transports.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import {
  MCP_PROTOCOL_VERSION,
  MCP_SUPPORTED_PROTOCOLS,
  MCP_ERROR,
  MCP_RESOURCES,
  MCP_PROMPTS,
  mcpToolList,
  createMcpServer,
  startHttpServer,
} from '../src/server/mcp.js';
import { startStdioServer } from '../src/server/stdio.js';
import { startServe } from '../src/server/serve.js';
import { TOOL_NAMES } from '../src/tools/tools.js';

/**
 * A fresh project for one test.
 * @returns {Promise<string>}
 */
async function tempProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ai-serve-mcp-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'index.js'), 'export const answer = 42;\n', 'utf8');
  return root;
}

test('the handshake answers with the version of the protocol', async () => {
  const server = createMcpServer({});
  const answer = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(answer.result.protocolVersion, '2025-03-26');
  assert.equal(answer.result.serverInfo.name, 'ai-serve');
  assert.ok(answer.result.capabilities.tools);
});

test('the handshake of an unknown version answers with the newest one', async () => {
  const server = createMcpServer({});
  const answer = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(answer.result.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.ok(MCP_SUPPORTED_PROTOCOLS.includes(MCP_PROTOCOL_VERSION));
});

test('the list of the tools holds the whole catalog', async () => {
  const server = createMcpServer({});
  const answer = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(answer.result.tools.length, TOOL_NAMES.length);
  const first = answer.result.tools[0];
  assert.ok(first.name);
  assert.ok(first.description);
  assert.equal(first.inputSchema.type, 'object');
});

test('the schemas of the tools are strict', () => {
  for (const tool of mcpToolList()) {
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(Array.isArray(tool.inputSchema.required));
  }
});

test('a forbidden tool is not listed', async () => {
  const server = createMcpServer({ config: { tools: { allowWrite: false } } });
  const answer = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  const names = answer.result.tools.map((tool) => tool.name);
  assert.ok(!names.includes('write_file'));
  assert.ok(names.includes('read_file'));
});

test('the call of a tool answers with its text', async () => {
  const root = await tempProject();
  const server = createMcpServer({ root });
  const answer = await server.handle({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'read_file', arguments: { path: 'src/index.js' } },
  });
  assert.equal(answer.result.isError, false);
  assert.match(answer.result.content[0].text, /answer = 42/);
  assert.equal(answer.result.content[0].type, 'text');
});

test('the call of an unknown tool is a refusal', async () => {
  const server = createMcpServer({});
  const answer = await server.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope' } });
  assert.equal(answer.error.code, MCP_ERROR.invalidParams);
});

test('the call of a forbidden tool is a refusal', async () => {
  const server = createMcpServer({ root: await tempProject(), config: { tools: { allowTerminal: false } } });
  const answer = await server.handle({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'run_command', arguments: { command: 'echo hi' } },
  });
  assert.equal(answer.error.code, MCP_ERROR.invalidParams);
});

test('a tool that fails answers with the error and not with a crash', async () => {
  const root = await tempProject();
  const server = createMcpServer({ root });
  const answer = await server.handle({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'read_file', arguments: { path: 'nope.txt' } },
  });
  assert.equal(answer.result.isError, true);
  assert.match(answer.result.content[0].text, /not found/);
});

test('the list of the resources holds the three views of the server', async () => {
  const server = createMcpServer({});
  const answer = await server.handle({ jsonrpc: '2.0', id: 8, method: 'resources/list' });
  assert.equal(answer.result.resources.length, MCP_RESOURCES.length);
});

test('the read of a resource answers with its text', async () => {
  const server = createMcpServer({ root: await tempProject() });
  const answer = await server.handle({ jsonrpc: '2.0', id: 9, method: 'resources/read', params: { uri: 'ai-serve://tools' } });
  assert.match(answer.result.contents[0].text, /read_file/);
});

test('the read of an unknown resource is a refusal', async () => {
  const server = createMcpServer({});
  const answer = await server.handle({ jsonrpc: '2.0', id: 10, method: 'resources/read', params: { uri: 'ai-serve://nope' } });
  assert.equal(answer.error.code, MCP_ERROR.invalidParams);
});

test('the list of the prompts holds the three prompts', async () => {
  const server = createMcpServer({});
  const answer = await server.handle({ jsonrpc: '2.0', id: 11, method: 'prompts/list' });
  assert.equal(answer.result.prompts.length, MCP_PROMPTS.length);
});

test('the read of a prompt answers with the messages', async () => {
  const server = createMcpServer({});
  const answer = await server.handle({
    jsonrpc: '2.0',
    id: 12,
    method: 'prompts/get',
    params: { name: 'analyze-task', arguments: { task: 'fix the tests' } },
  });
  assert.equal(answer.result.messages.length, 1);
  assert.match(answer.result.messages[0].content.text, /fix the tests/);
});

test('the read of an unknown prompt is a refusal', async () => {
  const server = createMcpServer({});
  const answer = await server.handle({ jsonrpc: '2.0', id: 13, method: 'prompts/get', params: { name: 'nope' } });
  assert.equal(answer.error.code, MCP_ERROR.invalidParams);
});

test('the ping answers with an empty object', async () => {
  const server = createMcpServer({});
  const answer = await server.handle({ jsonrpc: '2.0', id: 14, method: 'ping' });
  assert.deepEqual(answer.result, {});
});

test('an unknown method is a refusal', async () => {
  const server = createMcpServer({});
  const answer = await server.handle({ jsonrpc: '2.0', id: 15, method: 'nope/nope' });
  assert.equal(answer.error.code, MCP_ERROR.methodNotFound);
});

test('a message that is not an object is a refusal', async () => {
  const server = createMcpServer({});
  const answer = await server.handle('hello');
  assert.equal(answer.error.code, MCP_ERROR.invalidRequest);
});

test('a notification stays unanswered', async () => {
  const server = createMcpServer({});
  const answer = await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(answer, null);
});

test('a batch of messages answers with the answers of them', async () => {
  const server = createMcpServer({});
  const answer = await server.handle([
    { jsonrpc: '2.0', id: 16, method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 17, method: 'tools/list' },
  ]);
  assert.equal(answer.length, 2);
  assert.deepEqual(answer.map((item) => item.id), [16, 17]);
});

test('a call that runs too long is aborted and refused', async () => {
  const server = createMcpServer({
    timeoutMs: 120,
    callTool: () => new Promise(() => { }),
  });
  const answer = await server.handle({
    jsonrpc: '2.0',
    id: 18,
    method: 'tools/call',
    params: { name: 'read_file', arguments: { path: 'a.txt' } },
  });
  assert.equal(answer.error.code, MCP_ERROR.timeout);
});

test('a cancelled call is aborted and stays unanswered', async () => {
  let aborted = false;
  const server = createMcpServer({
    timeoutMs: 5000,
    callTool: (name, args, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
    }),
  });
  const promise = server.handle({
    jsonrpc: '2.0',
    id: 19,
    method: 'tools/call',
    params: { name: 'read_file', arguments: { path: 'a.txt' } },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const cancel = await server.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 19 } });
  assert.equal(cancel, null);
  assert.equal(await promise, null);
  assert.equal(aborted, true);
});

test('the stdio transport answers with a line per message', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  output.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim()) lines.push(JSON.parse(line));
    }
  });
  const server = createMcpServer({ root: await tempProject() });
  const handle = startStdioServer({ server, input, output });
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'ping' })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].result, {});
  handle.close();
});

test('the stdio transport refuses a broken line', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  output.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim()) lines.push(JSON.parse(line));
    }
  });
  const handle = startStdioServer({ server: createMcpServer({}), input, output });
  input.write('{oops\n');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].error.code, MCP_ERROR.parse);
  handle.close();
});

test('the http transport needs the token', async () => {
  const handle = await startHttpServer({ server: createMcpServer({}), port: 0, token: 'secret-token' });
  try {
    const without = await fetch(handle.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 21, method: 'ping' }),
    });
    assert.equal(without.status, 401);

    const withToken = await fetch(handle.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 22, method: 'ping' }),
    });
    assert.equal(withToken.status, 200);
    const answer = await withToken.json();
    assert.deepEqual(answer.result, {});
  } finally {
    await handle.close();
  }
});

test('the http transport keeps the health probe open', async () => {
  const handle = await startHttpServer({ server: createMcpServer({}), port: 0, token: 'secret-token' });
  try {
    const probe = await fetch(`http://127.0.0.1:${handle.port}/health`);
    assert.equal(probe.status, 200);
    const body = await probe.json();
    assert.equal(body.status, 'ok');
  } finally {
    await handle.close();
  }
});

test('the http transport answers a notification with 202', async () => {
  const handle = await startHttpServer({ server: createMcpServer({}), port: 0 });
  try {
    const answer = await fetch(handle.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    assert.equal(answer.status, 202);
  } finally {
    await handle.close();
  }
});

test('the mcp endpoint of the bus shares the port and the token', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ai-serve-mcp-'));
  const handle = await startServe({
    home,
    port: 0,
    token: 'bus-token',
    mcp: createMcpServer({ root: await tempProject() }),
  });
  try {
    const url = `${handle.httpURL}/mcp`;
    const withoutToken = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 23, method: 'ping' }),
    });
    assert.equal(withoutToken.status, 401);

    const withToken = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer bus-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 24, method: 'tools/list' }),
    });
    assert.equal(withToken.status, 200);
    const answer = await withToken.json();
    assert.ok(answer.result.tools.length > 0);
  } finally {
    await handle.close();
  }
});
