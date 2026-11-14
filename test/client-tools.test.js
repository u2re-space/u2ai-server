/**
 * @file test/client-tools.test.js
 * @module test/client-tools
 * @purpose The tools of the clients of the bus: the publication of them, the list of them,
 *          and the call of one of them.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createHub } from '../src/server/u2ai.js';
import { decodeFrame } from '../src/shared/decoder.js';

const TOKEN = 'secret-token';

/**
 * A socket of the hub that keeps the frames it got.
 * @returns {object}
 */
function fakeTransport() {
    const frames = [];
    return {
        frames,
        send(frame) { frames.push(frame); },
        close() { /* the socket is closed */ },
        /**
         * @param {string} type
         * @returns {object|undefined}
         */
        last(type) { return [...frames].reverse().find((frame) => frame.type === type); },
        /**
         * @param {string} type
         * @returns {object[]}
         */
        of(type) { return frames.filter((frame) => frame.type === type); },
    };
}

/**
 * A client that said hello.
 * @param {object} hub
 * @param {string} [name] the name of the client
 * @returns {Promise<{ socket: object, transport: object }>}
 */
async function client(hub, name = null) {
    const transport = fakeTransport();
    const socket = hub.connect(transport);
    await hub.receive(socket, { type: 'hello', role: 'client', token: TOKEN, ...(name ? { name } : {}) });
    transport.frames.length = 0;
    return { socket, transport };
}

test('the list of the tools of the clients is empty at the start', () => {
    const hub = createHub({ token: TOKEN });
    assert.deepEqual(hub.listClientTools(), []);
});

test('a client publishes the tools of its own', async () => {
    const hub = createHub({ token: TOKEN });
    const { socket, transport } = await client(hub, 'vscode');
    await hub.receive(socket, {
        type: 'tools.register',
        tools: [
            { name: 'read_file', description: 'Read a file of the workspace.', parameters: { type: 'object', properties: {} } },
            { name: 'run_in_terminal', description: 'Run a command in the terminal.' },
        ],
    });

    const tools = hub.listClientTools();
    assert.equal(tools.length, 2);
    assert.equal(tools[0].name, 'vscode__read_file');
    assert.equal(tools[0].client, 'vscode');
    assert.equal(tools[0].tool, 'read_file');
    assert.equal(tools[0].description, 'Read a file of the workspace.');
    assert.equal(tools[1].parameters.type, 'object');
    assert.deepEqual(transport.last('tools.registered').tools, ['vscode__read_file', 'vscode__run_in_terminal']);
});

test('a client without a name gets one', async () => {
    const hub = createHub({ token: TOKEN });
    const { socket } = await client(hub);
    await hub.receive(socket, { type: 'tools.register', tools: [{ name: 'read_file' }] });
    const tools = hub.listClientTools();
    assert.match(tools[0].name, /^client-[0-9a-f]{8}__read_file$/);
});

test('the list of a client replaces the list it had', async () => {
    const hub = createHub({ token: TOKEN });
    const { socket } = await client(hub, 'vscode');
    await hub.receive(socket, { type: 'tools.register', tools: [{ name: 'read_file' }, { name: 'write_file' }] });
    await hub.receive(socket, { type: 'tools.register', tools: [{ name: 'read_file' }] });
    const tools = hub.listClientTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'vscode__read_file');
});

test('the tools of a client are gone when the client is gone', async () => {
    const hub = createHub({ token: TOKEN });
    const { socket } = await client(hub, 'vscode');
    await hub.receive(socket, { type: 'tools.register', tools: [{ name: 'read_file' }] });
    assert.equal(hub.listClientTools().length, 1);
    hub.disconnect(socket);
    assert.deepEqual(hub.listClientTools(), []);
});

test('the server asks the client to run the tool', async () => {
    const hub = createHub({ token: TOKEN });
    const { socket, transport } = await client(hub, 'vscode');
    await hub.receive(socket, { type: 'tools.register', tools: [{ name: 'read_file' }] });

    const answer = hub.callClientTool('vscode__read_file', { path: 'notes.md' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const call = transport.last('tool.call');
    assert.equal(call.name, 'read_file');
    assert.deepEqual(call.arguments, { path: 'notes.md' });

    await hub.receive(socket, {
        type: 'tool.result',
        requestId: call.requestId,
        output: 'the content of the file',
        summary: 'read 1 file',
        changes: [],
    });

    const result = await answer;
    assert.equal(result.output, 'the content of the file');
    assert.equal(result.summary, 'read 1 file');
});

test('a tool that nobody published is refused', async () => {
    const hub = createHub({ token: TOKEN });
    await assert.rejects(() => hub.callClientTool('vscode__read_file'), /no client tool/);
});

test('a client that does not answer in time fails the call', async () => {
    const hub = createHub({ token: TOKEN });
    const { socket } = await client(hub, 'vscode');
    await hub.receive(socket, { type: 'tools.register', tools: [{ name: 'read_file' }] });
    await assert.rejects(
        () => hub.callClientTool('vscode__read_file', {}, { timeoutMs: 20 }),
        /did not answer in time/,
    );
});

test('the list of the tools must be a list of the tools', () => {
    assert.equal(decodeFrame(JSON.stringify({ type: 'tools.register' })).code, 'bad_request');
    assert.equal(decodeFrame(JSON.stringify({ type: 'tools.register', tools: {} })).code, 'bad_request');
    assert.equal(decodeFrame(JSON.stringify({ type: 'tools.register', tools: [{}] })).code, 'bad_request');
    assert.equal(
        decodeFrame(JSON.stringify({ type: 'tools.register', tools: [{ name: 'a' }, { name: 'a' }] })).code,
        'bad_request',
    );
    assert.equal(
        decodeFrame(JSON.stringify({ type: 'tools.register', tools: [{ name: 'a', parameters: 5 }] })).code,
        'bad_request',
    );
    assert.equal(
        decodeFrame(JSON.stringify({ type: 'tools.register', tools: [{ name: 'a' }] })).ok,
        true,
    );
});

test('a frame before hello is refused', async () => {
    const hub = createHub({ token: TOKEN });
    const transport = fakeTransport();
    const socket = hub.connect(transport);
    await hub.receive(socket, { type: 'tools.register', tools: [{ name: 'read_file' }] });
    assert.equal(transport.last('error').code, 'unauthorized');
    assert.deepEqual(hub.listClientTools(), []);
});
