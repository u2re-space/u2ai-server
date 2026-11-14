/**
 * @file test/services.test.js
 * @module test/services
 * @purpose The external services: the start of an outside `ai-serve`, the file with its
 *          address, the handshake of the bus, the state of the services, and the
 *          registration of a service in the config files.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile } from 'node:fs/promises';

import {
  normalizeService,
  startServiceProcess,
  connectBus,
  connectService,
  listServices,
  httpUrlOf,
  createToolProxy,
} from '../src/client/proxy.js';
import {
  readConfigFile,
  readMcpFile,
  registerService,
  removeService,
  registerMcpServer,
  removeMcpServer,
} from '../src/config/parser.js';
import { serveFile } from '../src/config/paths.js';
import { defaults, validateConfig } from '../src/config.js';
import { readServeRecord, pidAlive } from '../src/server/serve.js';
import { createRoleAsk } from '../src/roles/index.js';
import { main, EXIT } from '../src/cli.js';

const BIN = fileURLToPath(new URL('../bin/ai-serve.js', import.meta.url));

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
 * @returns {Promise<string>}
 */
async function fakeServer() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-serve-proxy-'));
  const file = path.join(dir, 'fake-mcp.mjs');
  await writeFile(file, FAKE_SERVER, 'utf8');
  return file;
}

/**
 * A fresh home directory for one test.
 * @returns {Promise<string>}
 */
async function tempHome() {
  return await mkdtemp(path.join(os.tmpdir(), 'ai-serve-services-'));
}

/**
 * Start an outside `ai-serve` with its own home.
 * @param {string} home
 * @returns {Promise<object>}
 */
async function startService(home) {
  return await startServiceProcess({
    command: process.execPath,
    args: [BIN, 'serve'],
    env: { AI_SERVE_HOME: home },
    timeoutMs: 20_000,
  });
}

/**
 * Run the CLI and keep what it prints.
 * @param {string[]} argv
 * @param {string} home
 * @returns {Promise<{ code: number, output: string }>}
 */
async function runCli(argv, home) {
  const previous = process.env.AI_SERVE_HOME;
  process.env.AI_SERVE_HOME = home;
  const lines = [];
  const log = console.log;
  console.log = (text) => { lines.push(String(text)); };
  try {
    const code = await main(argv);
    return { code, output: lines.join('\n') };
  } finally {
    console.log = log;
    if (previous === undefined) delete process.env.AI_SERVE_HOME;
    else process.env.AI_SERVE_HOME = previous;
  }
}

test('the entry of a service is checked', () => {
  const service = normalizeService({ name: 'other', url: 'ws://127.0.0.1:9000', token: 'secret' });
  assert.equal(service.name, 'other');
  assert.equal(service.url, 'ws://127.0.0.1:9000');
  assert.equal(service.token, 'secret');
  assert.equal(service.enabled, true);
  assert.throws(() => normalizeService({ name: 'other' }), /needs a command, a url or a file/);
});

test('the address of the bus becomes an http one', () => {
  assert.equal(httpUrlOf('ws://127.0.0.1:9000'), 'http://127.0.0.1:9000');
  assert.equal(httpUrlOf('wss://example.com'), 'https://example.com');
  assert.equal(httpUrlOf('http://127.0.0.1:9000/'), 'http://127.0.0.1:9000');
  assert.equal(httpUrlOf(''), '');
});

test('the outside service is started and its file is read', async () => {
  const home = await tempHome();
  const service = await startService(home);
  try {
    assert.match(service.url, /^ws:\/\/127\.0\.0\.1:\d+$/);
    assert.match(service.httpURL, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(service.token, /^[0-9a-f]{64}$/);
    assert.equal(service.record.pid, service.pid);
    assert.ok(pidAlive(service.pid));
    const record = await readServeRecord(serveFile(home));
    assert.equal(record.token, service.token);
    assert.equal(record.url, service.url);
  } finally {
    await service.close();
  }
});

test('the outside service stops and takes its file away', async () => {
  const home = await tempHome();
  const service = await startService(home);
  await service.close();
  assert.equal(pidAlive(service.pid), false);
  assert.equal(await readServeRecord(serveFile(home)), null);
});

test('a service that dies before it writes its file is a failure', async () => {
  await assert.rejects(
    () => startServiceProcess({
      command: process.execPath,
      args: ['-e', 'process.stderr.write("boom\\n"); process.exit(3);'],
      timeoutMs: 10_000,
    }),
    /boom/,
  );
});

test('the bus of the service says hello and answers ready', async () => {
  const home = await tempHome();
  const service = await startService(home);
  try {
    const bus = await connectBus({ url: service.url, token: service.token });
    assert.equal(bus.ready.type, 'ready');
    assert.equal(bus.ready.protocol, '0.4');
    assert.ok(Array.isArray(bus.ready.runs));
    bus.close();
  } finally {
    await service.close();
  }
});

test('the bus refuses a wrong token', async () => {
  const home = await tempHome();
  const service = await startService(home);
  try {
    await assert.rejects(() => connectBus({ url: service.url, token: 'wrong' }), /token is wrong/);
  } finally {
    await service.close();
  }
});

test('the service is connected by its entry', async () => {
  const home = await tempHome();
  const service = await startService(home);
  try {
    const client = await connectService({ name: 'other', url: service.url, token: service.token });
    assert.equal(client.name, 'other');
    assert.equal(client.bus.ready.type, 'ready');
    await client.close();
  } finally {
    await service.close();
  }
});

test('the connection breaks when the service stops', async () => {
  const home = await tempHome();
  const service = await startService(home);
  const bus = await connectBus({ url: service.url, token: service.token });
  const gone = new Promise((resolve) => bus.socket.addEventListener('close', () => resolve(true)));
  await service.close();
  assert.equal(await gone, true);
});

test('the state of the services is listed', async () => {
  const home = await tempHome();
  const service = await startService(home);
  try {
    const list = await listServices([
      { name: 'byFile', file: serveFile(home) },
      { name: 'byUrl', url: service.httpURL },
      { name: 'nowhere', url: 'http://127.0.0.1:1' },
      { name: 'off', url: service.httpURL, enabled: false },
    ]);
    assert.equal(list[0].status, 'running');
    assert.equal(list[0].pid, service.pid);
    assert.equal(list[1].status, 'running');
    assert.equal(list[2].status, 'stopped');
    assert.equal(list[3].status, 'disabled');
  } finally {
    await service.close();
  }
  const after = await listServices([{ name: 'byFile', file: serveFile(home) }]);
  assert.equal(after[0].status, 'stopped');
});

test('the service is registered in the config file', async () => {
  const home = await tempHome();
  const file = path.join(home, 'config.json');
  await registerService(file, { name: 'other', url: 'ws://127.0.0.1:9000', token: 'secret' });
  const config = await readConfigFile(file);
  assert.equal(config.services.length, 1);
  assert.equal(config.services[0].name, 'other');
  assert.equal(config.services[0].token, 'secret');

  await registerService(file, { name: 'other', url: 'ws://127.0.0.1:9100' });
  const second = await readConfigFile(file);
  assert.equal(second.services.length, 1);
  assert.equal(second.services[0].url, 'ws://127.0.0.1:9100');

  assert.equal(await removeService(file, 'other'), true);
  assert.equal((await readConfigFile(file)).services.length, 0);
  assert.equal(await removeService(file, 'other'), false);
});

test('the MCP server is registered in mcp.json', async () => {
  const home = await tempHome();
  const file = path.join(home, 'mcp.json');
  await registerMcpServer(file, { name: 'files', command: 'node', args: ['server.js'] });
  const servers = await readMcpFile(file);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].name, 'files');
  assert.equal(servers[0].command, 'node');
  assert.deepEqual(servers[0].args, ['server.js']);

  assert.equal(await removeMcpServer(file, 'files'), true);
  assert.equal((await readMcpFile(file)).length, 0);
});

test('the entry of a service is checked by the configuration', () => {
  const base = { ...defaults };
  validateConfig({ ...base, services: [{ name: 'other', url: 'ws://127.0.0.1:9000' }] });
  validateConfig({ ...base, services: [{ name: 'other', command: 'ai-serve', args: ['serve'] }] });
  validateConfig({ ...base, services: [{ name: 'other', file: '/tmp/serve.json' }] });
  assert.throws(
    () => validateConfig({ ...base, services: [{ name: 'other' }] }),
    /нужен url, command или file/,
  );
  assert.throws(
    () => validateConfig({ ...base, services: [{ name: 'other', url: 'ws://x', args: 'no' }] }),
    /\.args/,
  );
  assert.throws(
    () => validateConfig({ ...base, services: [{ name: 'other', url: 'ws://x', enabled: 'yes' }] }),
    /\.enabled/,
  );
});

test('the command services lists the services', async () => {
  const home = await tempHome();
  const answer = await runCli(['services', '--json'], home);
  assert.equal(answer.code, EXIT.ok);
  const rows = JSON.parse(answer.output);
  assert.equal(rows[0].name, 'self');
  assert.equal(rows[0].kind, 'ai-serve');
  assert.equal(rows[0].status, 'stopped');
});

test('the command services registers a service and an MCP server', async () => {
  const home = await tempHome();
  const added = await runCli(['services', 'add', 'other', '--url', 'ws://127.0.0.1:9000', '--token', 'secret'], home);
  assert.equal(added.code, EXIT.ok);
  const config = await readConfigFile(path.join(home, 'config.json'));
  assert.equal(config.services[0].name, 'other');
  assert.equal(config.services[0].url, 'ws://127.0.0.1:9000');

  const addedMcp = await runCli(['services', 'add-mcp', 'files', '--command', 'node', '--arg', 'server.js'], home);
  assert.equal(addedMcp.code, EXIT.ok);
  const servers = await readMcpFile(path.join(home, 'mcp.json'));
  assert.equal(servers[0].name, 'files');
  assert.deepEqual(servers[0].args, ['server.js']);

  const removed = await runCli(['services', 'remove', 'other'], home);
  assert.equal(removed.code, EXIT.ok);
  assert.equal((await readConfigFile(path.join(home, 'config.json'))).services.length, 0);
});

test('the proxy calls the tool of the server that owns it', async () => {
  const file = await fakeServer();
  const proxy = await createToolProxy([{ name: 'fake', command: process.execPath, args: [file] }]);
  try {
    assert.equal(proxy.errors.length, 0);
    assert.equal(proxy.tools.length, 1);
    assert.equal(proxy.tools[0].name, 'fake__echo');
    assert.equal(proxy.has('fake__echo'), true);
    assert.equal(proxy.has('echo'), false);
    const answer = await proxy.call('fake__echo', { text: 'hi' });
    assert.equal(answer.ok, true);
    assert.equal(answer.text, 'echo: hi');
    const unknown = await proxy.call('other__tool', {});
    assert.equal(unknown.ok, false);
    assert.match(unknown.error, /no external tool/i);
  } finally {
    await proxy.close();
  }
});

test('a server that does not come up does not stop the others', async () => {
  const file = await fakeServer();
  const proxy = await createToolProxy([
    { name: 'broken', command: process.execPath, args: ['-e', 'process.exit(1)'] },
    { name: 'fake', command: process.execPath, args: [file] },
  ]);
  try {
    assert.equal(proxy.errors.length, 1);
    assert.equal(proxy.errors[0].name, 'broken');
    assert.equal(proxy.tools.length, 1);
    const answer = await proxy.call('fake__echo', { text: 'still here' });
    assert.equal(answer.text, 'echo: still here');
  } finally {
    await proxy.close();
  }
});

test('the loop of a role calls the tool of an external server', async () => {
  const file = await fakeServer();
  const proxy = await createToolProxy([{ name: 'fake', command: process.execPath, args: [file] }]);
  try {
    const asked = [];
    const client = {
      responses: {
        create: async (params) => {
          asked.push(params);
          if (asked.length === 1) {
            return {
              id: 'resp_call',
              output: [{
                type: 'function_call',
                call_id: 'call_1',
                name: 'fake__echo',
                arguments: JSON.stringify({ text: 'from the model' }),
              }],
            };
          }
          return {
            id: 'resp_text',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }],
          };
        },
      },
    };
    const ask = createRoleAsk({ client, root: os.tmpdir(), proxy });
    const answer = await ask({ prompt: 'call the tool' });
    assert.equal(answer.text, 'done');
    assert.equal(answer.toolCalls.length, 1);
    assert.equal(answer.toolCalls[0].name, 'fake__echo');
    assert.equal(answer.toolCalls[0].ok, true);
    assert.equal(answer.toolCalls[0].text, 'echo: from the model');
    const names = asked[0].tools.map((tool) => tool.name);
    assert.ok(names.includes('fake__echo'));
  } finally {
    await proxy.close();
  }
});
