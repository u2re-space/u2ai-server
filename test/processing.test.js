/**
 * @file test/processing.test.js
 * @module test/processing
 * @purpose The processing of the tools in the bus: the capture of a tool by a client, the
 *          request of the tool to the holder, the answer of the holder, the timeout, and the
 *          execution of a tool by the server itself.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';

import { createHub } from '../src/server/u2ai.js';
import { validateClaim, validateToolResult } from '../src/shared/decoder.js';
import {
  resolveToolName,
  needsApproval,
  executeToolRequest,
  toolAllowed,
} from '../src/tools/tools.js';

const TOKEN = 'secret-token';

/**
 * A socket of the hub that keeps the frames it got.
 * @returns {object}
 */
function fakeTransport() {
  const frames = [];
  return {
    frames,
    closed: null,
    send(frame) { frames.push(frame); },
    close(code) { this.closed = code; },
    /**
     * The last frame of a type.
     * @param {string} type
     * @returns {object|undefined}
     */
    last(type) { return [...frames].reverse().find((frame) => frame.type === type); },
    /**
     * The frames of a type.
     * @param {string} type
     * @returns {object[]}
     */
    of(type) { return frames.filter((frame) => frame.type === type); },
  };
}

/**
 * A client that said hello.
 * @param {object} hub
 * @returns {Promise<{ socket: object, transport: object }>}
 */
async function client(hub) {
  const transport = fakeTransport();
  const socket = hub.connect(transport);
  await hub.receive(socket, { type: 'hello', role: 'client', token: TOKEN });
  transport.frames.length = 0;
  return { socket, transport };
}

/**
 * A client that started a run.
 * @param {object} hub
 * @returns {Promise<{ socket: object, transport: object, runId: string }>}
 */
async function owner(hub) {
  const { socket, transport } = await client(hub);
  await hub.receive(socket, { type: 'start', command: 'ask', prompt: 'read the file' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const runId = transport.last('run.started').run.id;
  transport.frames.length = 0;
  return { socket, transport, runId };
}

/**
 * A fresh project for one test.
 * @returns {Promise<string>}
 */
async function tempProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ai-serve-processing-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'index.js'), 'export const answer = 42;\n', 'utf8');
  return root;
}

test('the claim of a client is answered and published', async () => {
  const hub = createHub({ token: TOKEN });
  const { transport: ownerFrames, runId } = await owner(hub);
  const { socket, transport } = await client(hub);
  await hub.receive(socket, { type: 'processing.claim', runId, tools: ['read_file'] });

  const claimed = transport.last('processing.claimed');
  assert.equal(claimed.runId, runId);
  assert.deepEqual(claimed.tools, ['read_file']);

  const event = ownerFrames.last('run.event');
  assert.equal(event.event.type, 'processing.held');
  assert.deepEqual(event.event.tools, ['read_file']);
});

test('a socket that takes a tool gets it released', async () => {
  const hub = createHub({ token: TOKEN });
  const { runId } = await owner(hub);
  const first = await client(hub);
  const second = await client(hub);
  await hub.receive(first.socket, { type: 'processing.claim', runId, tools: ['read_file', 'write_file'] });
  await hub.receive(second.socket, { type: 'processing.claim', runId, tools: ['read_file'] });

  const released = first.transport.last('processing.released');
  assert.deepEqual(released.tools, ['read_file']);
  assert.equal(released.runId, runId);
  assert.deepEqual(second.transport.last('processing.claimed').tools, ['read_file']);
});

test('the claim of an unknown run is refused', async () => {
  const hub = createHub({ token: TOKEN });
  const { socket, transport } = await client(hub);
  await hub.receive(socket, { type: 'processing.claim', runId: 'nope', tools: ['read_file'] });
  assert.equal(transport.last('error').code, 'unknown_run');
});

test('a held tool is asked of its holder', async () => {
  const hub = createHub({ token: TOKEN });
  const { runId } = await owner(hub);
  const { socket, transport } = await client(hub);
  await hub.receive(socket, { type: 'processing.claim', runId, tools: ['read_file'] });

  const answer = hub.requestTool(runId, 'read_file', { path: 'src/index.js' });
  const request = transport.last('tool.request');
  assert.equal(request.name, 'read_file');
  assert.deepEqual(request.args, { path: 'src/index.js' });
  assert.equal(request.runId, runId);

  await hub.receive(socket, {
    type: 'tool.result',
    requestId: request.requestId,
    output: 'the content',
    summary: 'read src/index.js',
    changes: [],
  });
  const result = await answer;
  assert.equal(result.output, 'the content');
  assert.equal(result.summary, 'read src/index.js');
  assert.deepEqual(result.changes, []);
});

test('the error of the holder fails the request', async () => {
  const hub = createHub({ token: TOKEN });
  const { runId } = await owner(hub);
  const { socket, transport } = await client(hub);
  await hub.receive(socket, { type: 'processing.claim', runId, tools: ['read_file'] });

  const answer = hub.requestTool(runId, 'read_file', { path: 'src/index.js' });
  const request = transport.last('tool.request');
  await hub.receive(socket, { type: 'tool.result', requestId: request.requestId, error: 'the file is gone' });
  await assert.rejects(() => answer, /the file is gone/);
});

test('a holder that does not answer fails the request in time', async () => {
  const hub = createHub({ token: TOKEN, toolTimeoutMs: 30 });
  const { runId } = await owner(hub);
  const { socket } = await client(hub);
  await hub.receive(socket, { type: 'processing.claim', runId, tools: ['read_file'] });
  await assert.rejects(() => hub.requestTool(runId, 'read_file', { path: 'src/index.js' }), /in time/);
});

test('a tool that nobody holds is not asked of anyone', async () => {
  const hub = createHub({ token: TOKEN });
  const { runId } = await owner(hub);
  assert.equal(await hub.requestTool(runId, 'read_file', { path: 'src/index.js' }), null);
});

test('the answer of another socket is refused', async () => {
  const hub = createHub({ token: TOKEN });
  const { runId } = await owner(hub);
  const holder = await client(hub);
  const other = await client(hub);
  await hub.receive(holder.socket, { type: 'processing.claim', runId, tools: ['read_file'] });
  const answer = hub.requestTool(runId, 'read_file', { path: 'src/index.js' });
  const request = holder.transport.last('tool.request');
  await hub.receive(other.socket, { type: 'tool.result', requestId: request.requestId, output: 'x', summary: 'y' });
  assert.equal(other.transport.last('error').code, 'bad_request');
  await hub.receive(holder.socket, { type: 'tool.result', requestId: request.requestId, output: 'x', summary: 'y' });
  await answer;
});

test('the answer of an unknown request is refused', async () => {
  const hub = createHub({ token: TOKEN });
  const { socket, transport } = await client(hub);
  await hub.receive(socket, { type: 'tool.result', requestId: 'nope', output: 'x', summary: 'y' });
  assert.equal(transport.last('error').code, 'bad_request');
});

test('the server runs the tool that nobody holds', async () => {
  const hub = createHub({ token: TOKEN });
  const root = await tempProject();
  const { runId } = await owner(hub);
  const result = await hub.runTool(runId, 'read_file', { path: 'src/index.js' }, { root, approve: 'read' });
  assert.equal(result.ok, true);
  assert.match(result.output, /answer = 42/);
  assert.equal(result.summary, 'read src/index.js');
});

test('the permission of the user is asked before the tool of the server', async () => {
  const hub = createHub({ token: TOKEN });
  const root = await tempProject();
  const { socket, transport, runId } = await owner(hub);
  const answer = hub.runTool(runId, 'write_file', { path: 'src/new.js', content: 'x' }, { root });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const asked = transport.last('approval.request');
  assert.ok(asked);
  assert.equal(asked.name, 'write_file');
  await hub.receive(socket, { type: 'approve', requestId: asked.requestId, decision: 'yes' });
  const result = await answer;
  assert.equal(result.ok, true);
  assert.deepEqual(result.changes, [{ op: 'create', path: 'src/new.js' }]);
});

test('the old name of a tool goes to the new one', () => {
  assert.equal(resolveToolName('replace_text'), 'replace_in_file');
  assert.equal(resolveToolName('read_file'), 'read_file');
  assert.equal(resolveToolName('nope'), 'nope');
});

test('the categories of the tools decide the permission', () => {
  assert.equal(needsApproval('read_file', 'ask'), true);
  assert.equal(needsApproval('read_file', 'read'), false);
  assert.equal(needsApproval('write_file', 'read'), true);
  assert.equal(needsApproval('write_file', 'write'), false);
  assert.equal(needsApproval('run_command', 'write'), true);
  assert.equal(needsApproval('run_command', 'all'), false);
  assert.equal(needsApproval('nope', 'all'), true);
});

test('the request of a tool runs it and shapes the answer', async () => {
  const root = await tempProject();
  const result = await executeToolRequest('read_file', { path: 'src/index.js' }, { root, approve: 'read' });
  assert.equal(result.ok, true);
  assert.match(result.output, /answer = 42/);
  assert.equal(result.summary, 'read src/index.js');
  assert.deepEqual(result.changes, []);
});

test('the request of a tool without the permission does not run it', async () => {
  const root = await tempProject();
  const result = await executeToolRequest('write_file', { path: 'src/new.js', content: 'x' }, { root });
  assert.equal(result.ok, false);
  assert.equal(result.approval, 'required');
  assert.equal(result.changes.length, 0);
});

test('the request of a tool that does not exist is refused', async () => {
  const root = await tempProject();
  const result = await executeToolRequest('nope', {}, { root, approve: 'all' });
  assert.equal(result.ok, false);
  assert.match(result.error, /no tool named/);
});

test('the request of a tool that the configuration forbids is refused', async () => {
  const root = await tempProject();
  const result = await executeToolRequest('write_file', { path: 'src/new.js', content: 'x' }, {
    root,
    config: { tools: { allowWrite: false } },
    approve: 'all',
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /does not allow/);
  assert.equal(toolAllowed('write_file', { tools: { allowWrite: false } }), false);
});

test('the claim frame is checked', () => {
  assert.equal(validateClaim({ type: 'processing.claim', runId: 'r', tools: ['read_file'] }).ok, true);
  assert.equal(validateClaim({ type: 'processing.claim', tools: [] }).ok, false);
  assert.equal(validateClaim({ type: 'processing.claim', runId: 'r', tools: ['nope'] }).code, 'bad_request');
  assert.equal(validateClaim({ type: 'processing.claim', runId: 'r', tools: ['read_file', 'read_file'] }).code, 'bad_request');
});

test('the answer frame is checked', () => {
  assert.equal(validateToolResult({ type: 'tool.result', requestId: 'x', output: 'a', summary: 'b' }).ok, true);
  assert.equal(validateToolResult({ type: 'tool.result', requestId: 'x', error: 'boom' }).ok, true);
  assert.equal(validateToolResult({ type: 'tool.result', requestId: 'x' }).code, 'bad_request');
  assert.equal(validateToolResult({ type: 'tool.result', requestId: 'x', output: 'a', summary: 'b', changes: [{ op: 'nope', path: 'p' }] }).code, 'bad_request');
  assert.equal(validateToolResult({ type: 'tool.result', requestId: 'x', output: 'a', summary: 'b', changes: [{ op: 'edit', path: 'p' }] }).ok, true);
});
