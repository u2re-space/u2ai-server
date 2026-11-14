/**
 * @file test/serve.test.js
 * @module test/serve
 * @purpose The server: the handshake, the HTTP part, the file with the address, and the
 *          refusals — a busy port and a server that is already running.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';

import { startServe, pidAlive, readServeRecord, writeServeRecord } from '../src/server/serve.js';
import { acceptKey, encodeWsFrame, listenWebSocket, MAX_FRAME_BYTES } from '../src/server/ws.js';
import { createHttpHandler, checkToken, readJsonBody } from '../src/server/http.js';

/**
 * A fresh home directory for one test.
 * @returns {Promise<string>}
 */
async function tempHome() {
    return await mkdtemp(path.join(os.tmpdir(), 'ai-serve-test-'));
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
    const text = await answer.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
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

test('the handshake key is the one of the standard', () => {
    assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('the frame of the server carries its length', () => {
    const small = encodeWsFrame(0x1, 'abc');
    assert.equal(small[0], 0x81);
    assert.equal(small[1], 3);
    const big = encodeWsFrame(0x1, 'x'.repeat(1000));
    assert.equal(big[1], 126);
    assert.equal(big.readUInt16BE(2), 1000);
});

test('the server writes the file with its address and removes it on the way out', async () => {
    const home = await tempHome();
    const handle = await startServe({ home, port: 0 });
    const file = path.join(home, 'serve.json');
    const record = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(record.pid, process.pid);
    assert.equal(record.url, `ws://127.0.0.1:${handle.port}`);
    assert.equal(record.token, handle.token);
    assert.ok(record.token.length >= 32);
    await handle.close();
    assert.equal(await readServeRecord(file), null);
});

test('the file with the token is readable by its owner only', async (t) => {
    if (process.platform === 'win32') {
        t.skip('Windows has no file modes.');
        return;
    }
    const home = await tempHome();
    const handle = await startServe({ home, port: 0 });
    const info = await stat(path.join(home, 'serve.json'));
    assert.equal(info.mode & 0o777, 0o600);
    await handle.close();
});

test('a busy port is refused', async () => {
    const home = await tempHome();
    const other = await tempHome();
    const first = await startServe({ home, port: 0 });
    await assert.rejects(
        () => startServe({ home: other, port: first.port }),
        (error) => {
            assert.equal(error.code, 'PORT_BUSY');
            assert.match(error.message, /busy/);
            return true;
        },
    );
    await first.close();
});

test('a server that is already running is refused', async () => {
    const home = await tempHome();
    await writeServeRecord(path.join(home, 'serve.json'), {
        pid: process.pid,
        url: 'ws://127.0.0.1:1234',
        token: 'x',
    });
    await assert.rejects(
        () => startServe({ home, port: 0 }),
        (error) => {
            assert.equal(error.code, 'ALREADY_RUNNING');
            assert.match(error.message, /already running/);
            return true;
        },
    );
});

test('a stale file does not stop the server', async () => {
    const home = await tempHome();
    await writeServeRecord(path.join(home, 'serve.json'), {
        pid: 999_999,
        url: 'ws://127.0.0.1:1234',
        token: 'x',
    });
    const handle = await startServe({ home, port: 0 });
    assert.ok(handle.port > 0);
    await handle.close();
});

test('the pid of a live process is alive', () => {
    assert.equal(pidAlive(process.pid), true);
    assert.equal(pidAlive(0), false);
    assert.equal(pidAlive(-1), false);
});

test('the health probe answers without a token', async () => {
    const home = await tempHome();
    const handle = await startServe({ home, port: 0 });
    const answer = await request(`${handle.httpURL}/health`);
    assert.equal(answer.status, 200);
    assert.equal(answer.json.status, 'ok');
    assert.equal(answer.json.pid, process.pid);
    await handle.close();
});

test('the tool list needs the token', async () => {
    const home = await tempHome();
    const handle = await startServe({ home, port: 0, tools: [{ name: 'read_text_file', category: 'read' }] });
    const denied = await request(`${handle.httpURL}/v1/tools`);
    assert.equal(denied.status, 401);
    const allowed = await request(`${handle.httpURL}/v1/tools`, { token: handle.token });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.json.tools[0].name, 'read_text_file');
    await handle.close();
});

test('an unknown route is not the answer of the server', async () => {
    const home = await tempHome();
    const handle = await startServe({ home, port: 0 });
    const answer = await request(`${handle.httpURL}/nope`);
    assert.equal(answer.status, 426);
    await handle.close();
});

test('the bridge without a model answers that it is not ready', async () => {
    const home = await tempHome();
    const handle = await startServe({ home, port: 0 });
    const answer = await request(`${handle.httpURL}/v1/complete`, {
        method: 'POST',
        token: handle.token,
        body: { id: 'c1', content: 'const a = 1;', cursor: { line: 0, character: 3 } },
    });
    assert.equal(answer.status, 501);
    assert.equal(answer.json.error.code, 'not_implemented');
    await handle.close();
});

test('the completion request is checked before it reaches the model', async () => {
    const home = await tempHome();
    const handle = await startServe({ home, port: 0 });
    const answer = await request(`${handle.httpURL}/v1/complete`, {
        method: 'POST',
        token: handle.token,
        body: { id: 'c1', content: 'x' },
    });
    assert.equal(answer.status, 400);
    assert.equal(answer.json.error.code, 'bad_request');
    await handle.close();
});

test('the token is read from the header, the query and the custom header', () => {
    const withHeader = { headers: { authorization: 'Bearer abc' } };
    const withQuery = { headers: {}, url: '/v1/tools?token=abc' };
    const withCustom = { headers: { 'x-ai-serve-token': 'abc' } };
    assert.equal(checkToken(withHeader, ['abc']), true);
    assert.equal(checkToken(withQuery, ['abc']), true);
    assert.equal(checkToken(withCustom, ['abc']), true);
    assert.equal(checkToken({ headers: {}, url: '/' }, ['abc']), false);
    assert.equal(checkToken({ headers: {} }, []), true);
});

test('the body of a request is read with a cap', async () => {
    const chunks = [Buffer.from('{"a":'), Buffer.from('1}')];
    const req = async function* request() { yield* chunks; };
    const body = await readJsonBody(req(), 1024);
    assert.equal(body.ok, true);
    assert.deepEqual(body.value, { a: 1 });
});

test('the socket of a client carries the frames', async () => {
    const received = [];
    const listener = await listenWebSocket({
        port: 0,
        onConnection: (connection) => {
            connection.on('message', (text) => {
                received.push(text);
                connection.send(`echo:${text}`);
            });
        },
    });
    const socket = new WebSocket(listener.url);
    const answer = nextMessage(socket);
    await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
    });
    socket.send('hello');
    assert.equal(await answer, 'echo:hello');
    assert.deepEqual(received, ['hello']);
    socket.close();
    await listener.close();
});

test('a frame bigger than the limit closes the socket', async () => {
    const listener = await listenWebSocket({
        port: 0,
        maxFrameBytes: 1024,
        onConnection: () => {},
    });
    const socket = new WebSocket(listener.url);
    await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
    });
    const closed = new Promise((resolve) => {
        socket.addEventListener('close', (event) => resolve(event.code), { once: true });
    });
    socket.send('x'.repeat(2048));
    assert.equal(await closed, 1009);
    await listener.close();
});

test('the limit of a frame is the limit of the protocol', () => {
    assert.equal(MAX_FRAME_BYTES, 1_048_576);
});

test('the file of the address is read as a record', async () => {
    const home = await tempHome();
    const file = path.join(home, 'serve.json');
    await writeFile(file, '{ broken');
    assert.equal(await readServeRecord(file), null);
    await writeFile(file, '{"pid":1}');
    assert.deepEqual(await readServeRecord(file), { pid: 1 });
});
