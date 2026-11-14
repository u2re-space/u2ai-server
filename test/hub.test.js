/**
 * @file test/hub.test.js
 * @module test/hub
 * @purpose The hub of the bus: the life of a run, the subscriptions, the approval, the
 *          question, the input of the owner, and the end of a run.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createHub, attachConnection } from '../src/server/u2ai.js';
import { listenWebSocket } from '../src/server/ws.js';

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

test('a client without the token is refused', async () => {
    const hub = createHub({ token: TOKEN });
    const transport = fakeTransport();
    const socket = hub.connect(transport);
    await hub.receive(socket, { type: 'hello', role: 'client', token: 'wrong' });
    assert.equal(transport.last('error').code, 'unauthorized');
    assert.equal(transport.closed, 1008);
});

test('a frame before hello is refused', async () => {
    const hub = createHub({ token: TOKEN });
    const transport = fakeTransport();
    const socket = hub.connect(transport);
    await hub.receive(socket, { type: 'start', command: 'ask', prompt: 'x' });
    assert.equal(transport.last('error').code, 'unauthorized');
    assert.equal(transport.closed, 1008);
});

test('the hello frame is answered with the ready frame', async () => {
    const hub = createHub({ token: TOKEN });
    const transport = fakeTransport();
    const socket = hub.connect(transport);
    await hub.receive(socket, { type: 'hello', role: 'client', token: TOKEN });
    const ready = transport.last('ready');
    assert.equal(ready.type, 'ready');
    assert.deepEqual(ready.runs, []);
});

test('the second hello is refused', async () => {
    const hub = createHub({ token: TOKEN });
    const { socket, transport } = await client(hub);
    await hub.receive(socket, { type: 'hello', role: 'client', token: TOKEN });
    assert.equal(transport.last('error').code, 'conflict');
});

test('a run is announced, reported and ended', async () => {
    const started = [];
    const hub = createHub({
        token: TOKEN,
        onStart: async (run, frame) => {
            started.push({ id: run.id, command: frame.command });
            hub.publish(run.id, { type: 'text.delta', text: 'Hello' });
            hub.finish(run.id, 'completed', 0);
        },
    });
    const { socket, transport } = await client(hub);
    await hub.receive(socket, { type: 'start', command: 'ask', prompt: 'hi' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const announced = transport.last('run.started');
    assert.equal(announced.run.command, 'ask');
    assert.equal(announced.run.status, 'running');
    const event = transport.last('run.event');
    assert.equal(event.event.text, 'Hello');
    assert.equal(event.runId, announced.run.id);
    const ended = transport.last('run.ended');
    assert.equal(ended.status, 'completed');
    assert.equal(ended.exitCode, 0);
    assert.equal(started.length, 1);
});

test('a start frame with an unknown field is refused', async () => {
    const hub = createHub({ token: TOKEN });
    const { socket, transport } = await client(hub);
    await hub.receive(socket, { type: 'start', command: 'ask', prompt: 'hi', nope: 1 });
    assert.equal(transport.last('error').code, 'invalid_start');
});

test('a start frame of a background run is refused', async () => {
    const hub = createHub({ token: TOKEN });
    const { socket, transport } = await client(hub);
    await hub.receive(socket, { type: 'start', command: 'ask', prompt: 'hi', background: true });
    assert.equal(transport.last('error').code, 'invalid_start');
    assert.match(transport.last('error').message, /background/);
});

test('the approval waits for the answer of the owner', async () => {
    let decision = null;
    const hub = createHub({
        token: TOKEN,
        onStart: async (run) => {
            decision = await hub.requestApproval(run.id, { name: 'write_file', category: 'write', preview: 'a.txt' });
            hub.finish(run.id, 'completed', 0);
        },
    });
    const { socket, transport } = await client(hub);
    await hub.receive(socket, { type: 'start', command: 'run', prompt: 'write' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const request = transport.last('approval.request');
    assert.equal(request.name, 'write_file');
    assert.equal(request.category, 'write');
    assert.equal(request.preview, 'a.txt');

    await hub.receive(socket, { type: 'approve', requestId: request.requestId, decision: 'yes' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(decision, 'yes');
    assert.equal(transport.last('run.ended').status, 'completed');
});

test('the question waits for the text of the owner', async () => {
    let answer = null;
    const hub = createHub({
        token: TOKEN,
        onStart: async (run) => {
            answer = await hub.requestQuestion(run.id, 'Which file?');
            hub.finish(run.id, 'completed', 0);
        },
    });
    const { socket, transport } = await client(hub);
    await hub.receive(socket, { type: 'start', command: 'ask', prompt: 'x' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const request = transport.last('question.request');
    assert.equal(request.question, 'Which file?');
    await hub.receive(socket, { type: 'answer', requestId: request.requestId, text: 'README.md' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(answer, 'README.md');
});

test('the approval of a finished run ends with abort', async () => {
    let decision = null;
    const hub = createHub({
        token: TOKEN,
        onStart: async (run) => {
            decision = await hub.requestApproval(run.id, { name: 'write_file' });
        },
    });
    const { socket } = await client(hub);
    await hub.receive(socket, { type: 'start', command: 'run', prompt: 'write' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    hub.finish(hub.runs.keys().next().value, 'failed', 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(decision, 'abort');
});

test('the input of the owner continues the run', async () => {
    let input = null;
    const hub = createHub({
        token: TOKEN,
        onStart: async (run) => {
            input = await hub.waitInput(run.id);
            hub.finish(run.id, 'completed', 0);
        },
    });
    const { socket } = await client(hub);
    await hub.receive(socket, { type: 'start', command: 'run', prompt: 'write' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const runId = hub.runs.keys().next().value;
    await hub.receive(socket, { type: 'input', runId, text: 'second' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(input, 'second');
});

test('the first prompt of a chat is the first line of the run', async () => {
    const hub = createHub({ token: TOKEN });
    const { socket } = await client(hub);
    await hub.receive(socket, { type: 'start', command: 'chat', prompt: 'first' });
    const run = hub.runs.values().next().value;
    assert.equal(run.queue[0], 'first');
});

test('the cancel frame ends the run', async () => {
    const hub = createHub({ token: TOKEN, onStart: async () => {} });
    const { socket, transport } = await client(hub);
    await hub.receive(socket, { type: 'start', command: 'run', prompt: 'x' });
    const runId = hub.runs.keys().next().value;
    await hub.receive(socket, { type: 'cancel', runId });
    assert.equal(transport.last('run.ended').status, 'cancelled');
    assert.equal(hub.runs.has(runId), false);
});

test('the owner of the run alone may cancel it', async () => {
    const hub = createHub({ token: TOKEN, onStart: async () => {} });
    const owner = await client(hub);
    const other = await client(hub);
    await hub.receive(owner.socket, { type: 'start', command: 'run', prompt: 'x' });
    const runId = hub.runs.keys().next().value;
    await hub.receive(other.socket, { type: 'cancel', runId });
    assert.equal(other.transport.last('error').code, 'not_owner');
    assert.equal(hub.runs.has(runId), true);
});

test('the socket of the owner that dies ends the run', async () => {
    const hub = createHub({ token: TOKEN, onStart: async () => {} });
    const owner = await client(hub);
    await hub.receive(owner.socket, { type: 'start', command: 'run', prompt: 'x' });
    const runId = hub.runs.keys().next().value;
    hub.disconnect(owner.socket);
    assert.equal(hub.runs.has(runId), false);
});

test('a subscriber sees the events of the run, another client does not', async () => {
    const hub = createHub({ token: TOKEN, onStart: async () => {} });
    const owner = await client(hub);
    const watcher = await client(hub);
    const stranger = await client(hub);
    await hub.receive(owner.socket, { type: 'start', command: 'run', prompt: 'x' });
    const runId = hub.runs.keys().next().value;
    await hub.receive(watcher.socket, { type: 'subscribe', runId });
    hub.publish(runId, { type: 'text.delta', text: 'x' });
    assert.equal(watcher.transport.of('run.event').length, 1);
    assert.equal(stranger.transport.of('run.event').length, 0);
});

test('the star subscribes to every run', async () => {
    const hub = createHub({ token: TOKEN, onStart: async () => {} });
    const watcher = await client(hub);
    await hub.receive(watcher.socket, { type: 'subscribe', runId: '*' });
    const owner = await client(hub);
    await hub.receive(owner.socket, { type: 'start', command: 'run', prompt: 'x' });
    const runId = hub.runs.keys().next().value;
    hub.publish(runId, { type: 'text.delta', text: 'x' });
    assert.equal(watcher.transport.of('run.event').length, 1);
});

test('the subscribe frame of an unknown run is refused', async () => {
    const hub = createHub({ token: TOKEN });
    const { socket, transport } = await client(hub);
    await hub.receive(socket, { type: 'subscribe', runId: 'nope' });
    assert.equal(transport.last('error').code, 'unknown_run');
});

test('the ping frame is answered with a pong', async () => {
    const hub = createHub({ token: TOKEN });
    const { socket, transport } = await client(hub);
    await hub.receive(socket, { type: 'ping', id: 'p1' });
    assert.equal(transport.last('pong').id, 'p1');
});

test('the shutdown of the hub ends every run', async () => {
    const hub = createHub({ token: TOKEN, onStart: async () => {} });
    const { socket } = await client(hub);
    await hub.receive(socket, { type: 'start', command: 'run', prompt: 'x' });
    assert.equal(hub.runs.size, 1);
    hub.shutdown();
    assert.equal(hub.runs.size, 0);
});

test('the socket of the server carries the frames of the hub', async () => {
    const hub = createHub({ token: TOKEN, onStart: async () => {} });
    const listener = await listenWebSocket({
        port: 0,
        onConnection: (connection) => attachConnection(hub, connection),
    });
    const socket = new WebSocket(listener.url);
    const frames = [];
    socket.addEventListener('message', (event) => frames.push(JSON.parse(event.data)));
    await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
    });
    socket.send(JSON.stringify({ type: 'hello', role: 'client', token: TOKEN }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(frames.at(-1).type, 'ready');

    socket.send(JSON.stringify({ type: 'start', command: 'ask', prompt: 'hi' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(frames.some((frame) => frame.type === 'run.started'));

    socket.send('{ broken');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(frames.at(-1).code, 'bad_json');

    socket.close();
    await listener.close();
});
