/**
 * @file test/autocomplete.test.js
 * @module test/autocomplete
 * @purpose The Tab-completion: the window of the document, the cursor in the slice, the
 *          refusal of a giant line, the clean-up of the insertion, and the two bridges of
 *          the completion — HTTP and WebSocket.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';

import {
  COMPLETION_INSTRUCTIONS,
  MAX_LINE_BYTES,
  AutocompleteError,
  buildCompletionContext,
  completionPrompt,
  stripCompletion,
  stripDoubledClosers,
  acceptInsertion,
  fitInsertion,
  completeAtCursor,
} from '../src/agent/autocomplete.js';
import { startServe } from '../src/server/serve.js';
import { COMPLETION_WINDOWS, MAX_COMPLETION_CONTEXT_BYTES, MAX_COMPLETION_FRAME_BYTES } from '../src/shared/protocol.js';

/**
 * A fresh home directory for one test.
 * @returns {Promise<string>}
 */
async function tempHome() {
  return await mkdtemp(path.join(os.tmpdir(), 'ai-serve-complete-'));
}

/**
 * A document of many lines.
 * @param {number} count the number of the lines
 * @param {number} size the length of every line
 * @returns {string}
 */
function bigDocument(count, size) {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    rows.push(`line ${index} ${'x'.repeat(size)}`);
  }
  return rows.join('\n');
}

/**
 * A client of the API that answers with one text.
 * @param {string} text
 * @returns {{ client: object, calls: object[] }}
 */
function fakeClient(text) {
  const calls = [];
  return {
    calls,
    client: {
      responses: {
        create: async (params) => {
          calls.push(params);
          return {
            id: 'resp_complete',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
          };
        },
      },
    },
  };
}

/**
 * The answer of an HTTP request of the server.
 * @param {string} url
 * @param {{ method?: string, token?: string, body?: object }} [options]
 * @returns {Promise<{ status: number, json: object }>}
 */
async function request(url, { method = 'GET', token = null, body = null } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const answer = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await answer.text();
  let json = null;
  try { json = JSON.parse(raw); } catch { json = { raw }; }
  return { status: answer.status, json };
}

/**
 * Wait for a frame of a socket.
 * @param {WebSocket} socket
 * @param {number} [timeoutMs]
 * @returns {Promise<string>}
 */
function nextMessage(socket, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The socket said nothing in time.')), timeoutMs);
    socket.addEventListener('message', (event) => {
      clearTimeout(timer);
      resolve(typeof event.data === 'string' ? event.data : String(event.data));
    }, { once: true });
  });
}

test('a small document goes to the model whole', () => {
  const context = buildCompletionContext({
    content: 'const a = 1;\nconst b = 2;\n',
    cursor: { line: 1, character: 0 },
  });
  assert.equal(context.truncated, false);
  assert.equal(context.startLine, 0);
  assert.match(context.focus, /const a = 1;/);
  assert.match(context.focus, /const b = 2;/);
  assert.match(context.prompt, /The \| marks the cursor/);
});

test('the cursor is marked in the slice', () => {
  const context = buildCompletionContext({
    content: 'const a = 1;\nconst b = 2;\n',
    cursor: { line: 1, character: 6 },
  });
  assert.match(context.focus, /const \|b = 2;/);
  assert.equal(context.beforeCursor, 'const ');
  assert.equal(context.afterCursor, 'b = 2;');
});

test('the cursor of the editor is clamped to the text', () => {
  const context = buildCompletionContext({
    content: 'one\ntwo',
    cursor: { line: 99, character: 99 },
  });
  assert.equal(context.cursorLine, 1);
  assert.equal(context.beforeCursor, 'two');
});

test('a big document is cut to the lines around the cursor', () => {
  const content = bigDocument(400, 1000);
  assert.ok(Buffer.byteLength(content, 'utf8') > MAX_COMPLETION_CONTEXT_BYTES);
  const context = buildCompletionContext({
    content,
    cursor: { line: 300, character: 0 },
  });
  assert.equal(context.truncated, true);
  assert.equal(context.startLine, 100);
  assert.deepEqual([...context.radius], [...COMPLETION_WINDOWS[0]]);
  assert.ok(!context.focus.includes('line 0 '));
  assert.match(context.focus, /line 100 /);
});

test('the window shrinks when the frame does not fit', () => {
  const context = buildCompletionContext({
    content: bigDocument(300, 100),
    cursor: { line: 150, character: 0 },
    maxContextBytes: 1000,
    maxFrameBytes: 1500,
  });
  assert.equal(context.truncated, true);
  assert.ok(context.radius[0] < COMPLETION_WINDOWS[0][0]);
  assert.ok(Buffer.byteLength(context.focus, 'utf8') <= 1500);
  assert.ok(context.startLine > 0);
});

test('a giant line of the cursor is refused', () => {
  const content = `small\n${'x'.repeat(MAX_LINE_BYTES + 10)}\n`;
  assert.throws(
    () => buildCompletionContext({ content, cursor: { line: 1, character: 0 } }),
    (error) => {
      assert.ok(error instanceof AutocompleteError);
      assert.equal(error.code, 'line_too_long');
      return true;
    },
  );
});

test('a giant line away from the cursor is omitted', () => {
  const content = ['one', 'x'.repeat(MAX_LINE_BYTES + 10), 'three'].join('\n');
  const context = buildCompletionContext({
    content,
    cursor: { line: 2, character: 0 },
    maxContextBytes: 10,
  });
  assert.deepEqual(context.omittedLines, [1]);
  assert.match(context.focus, /\[line 2 omitted\]/);
});

test('the prompt names the file and the language', () => {
  const context = buildCompletionContext({
    content: 'one\n',
    cursor: { line: 0, character: 3 },
    path: 'src/index.js',
    language: 'js',
  });
  assert.match(context.prompt, /Focused file: src\/index\.js/);
  assert.match(context.prompt, /Language: js/);
  assert.match(completionPrompt(context, { path: 'src/index.js' }), /Cursor: line 1/);
});

test('the fence of the answer goes away', () => {
  assert.equal(stripCompletion('```js\nconst a = 1;\n```'), 'const a = 1;');
  assert.equal(stripCompletion('const a = 1;'), 'const a = 1;');
  assert.equal(stripCompletion(''), '');
});

test('the closer that the buffer holds is not inserted twice', () => {
  assert.equal(stripDoubledClosers('  return 1;\n}', '}'), '  return 1;');
  assert.equal(stripDoubledClosers('  return 1;', '}'), '  return 1;');
  assert.equal(stripDoubledClosers('  return 1;', ''), '  return 1;');
});

test('the insertion keeps only what the buffer does not hold', () => {
  // The model echoed the whole line: the buffer already holds `const ` and ` = 1;`.
  assert.equal(fitInsertion('const a = 1;', 'const ', ' = 1;'), 'a');
  assert.equal(fitInsertion(' const b = 2;', 'const ', ''), ' const b = 2;');
  assert.equal(fitInsertion('value', 'const ', ''), 'value');
});

test('a planning paragraph is not an insertion', () => {
  assert.equal(acceptInsertion('const a = 1;'), 'const a = 1;');
  assert.equal(acceptInsertion('We need to check the cursor and then we should probably write a small helper for it'), '');
});

test('the completion asks the model and cleans the answer', async () => {
  const { client, calls } = fakeClient('```js\nconst b = 2;\n```');
  const out = await completeAtCursor({
    client,
    config: { model: 'test-model' },
    frame: { id: 'c1', content: 'const a = 1;\n', cursor: { line: 0, character: 12 }, path: 'src/index.js' },
  });
  assert.equal(out.id, 'c1');
  assert.equal(out.text, 'const b = 2;');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'test-model');
  assert.equal(calls[0].instructions, COMPLETION_INSTRUCTIONS);
  assert.match(calls[0].input, /Focused file: src\/index\.js/);
});

test('the completion needs a client', async () => {
  await assert.rejects(() => completeAtCursor({ frame: {} }), /client/);
});

test('the HTTP bridge needs the token and answers with the text', async () => {
  const home = await tempHome();
  const handle = await startServe({
    home,
    port: 0,
    onComplete: async (frame) => ({ id: frame.id, text: 'const b = 2;' }),
  });
  const body = { id: 'c1', content: 'const a = 1;\n', cursor: { line: 0, character: 12 } };
  const without = await request(`${handle.httpURL}/v1/complete`, { method: 'POST', body });
  assert.equal(without.status, 401);
  assert.equal(without.json.error.code, 'unauthorized');
  const withToken = await request(`${handle.httpURL}/v1/complete`, { method: 'POST', token: handle.token, body });
  assert.equal(withToken.status, 200);
  assert.equal(withToken.json.text, 'const b = 2;');
  await handle.close();
});

test('the WebSocket bridge answers with the completion', async () => {
  const home = await tempHome();
  const handle = await startServe({
    home,
    port: 0,
    onComplete: async (frame) => ({ id: frame.id, text: 'const b = 2;' }),
  });
  const socket = new WebSocket(`ws://127.0.0.1:${handle.port}/v1/complete?token=${handle.token}`);
  const answer = nextMessage(socket);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('The socket did not open.')), { once: true });
  });
  socket.send(JSON.stringify({ type: 'complete', id: 'c1', content: 'const a = 1;\n', cursor: { line: 0, character: 12 } }));
  const frame = JSON.parse(await answer);
  assert.equal(frame.type, 'completion');
  assert.equal(frame.id, 'c1');
  assert.equal(frame.text, 'const b = 2;');
  socket.close();
  await handle.close();
});

test('the WebSocket bridge refuses a socket without the token', async () => {
  const home = await tempHome();
  const handle = await startServe({
    home,
    port: 0,
    onComplete: async () => ({ text: 'never' }),
  });
  const socket = new WebSocket(`ws://127.0.0.1:${handle.port}/v1/complete`);
  const answer = nextMessage(socket);
  const frame = JSON.parse(await answer);
  assert.equal(frame.type, 'error');
  assert.equal(frame.code, 'unauthorized');
  socket.close();
  await handle.close();
});

test('the frame of the completion is checked', async () => {
  const home = await tempHome();
  const handle = await startServe({
    home,
    port: 0,
    onComplete: async () => ({ text: 'never' }),
  });
  const bad = await request(`${handle.httpURL}/v1/complete`, {
    method: 'POST',
    token: handle.token,
    body: { id: 'c1', content: 'x' },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'bad_request');
  await handle.close();
});

test('the limits of the protocol are the ones of the window', () => {
  assert.equal(MAX_COMPLETION_CONTEXT_BYTES, 262144);
  assert.equal(MAX_COMPLETION_FRAME_BYTES, 900000);
});
