/**
 * @file test/mcp-client-tools.test.js
 * @module test/mcp-client-tools
 * @purpose The MCP server of the package: the tools of the clients of the bus in the list
 *          of the tools, and the call of one of them.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createMcpServer, mcpClientToolList } from '../src/server/mcp.js';
import { createHub } from '../src/server/u2ai.js';

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
    };
}

/**
 * A client of the bus that published its tools.
 * @param {object} hub
 * @param {string} name
 * @returns {Promise<{ socket: object, transport: object }>}
 */
async function client(hub, name) {
    const transport = fakeTransport();
    const socket = hub.connect(transport);
    await hub.receive(socket, { type: 'hello', role: 'client', token: TOKEN, name });
    await hub.receive(socket, {
        type: 'tools.register',
        tools: [
            {
                name: 'read_file',
                description: 'Read a file of the workspace.',
                parameters: { type: 'object', properties: { path: { type: 'string' } } },
            },
        ],
    });
    return { socket, transport };
}

test('the list of the tools of the clients is in the shape of MCP', () => {
    const list = mcpClientToolList([
        { name: 'vscode__read_file', description: 'Read a file.', parameters: { type: 'object' } },
        { name: 'vscode__run', description: '' },
        { name: '', description: 'no name' },
    ]);
    assert.equal(list.length, 2);
    assert.equal(list[0].name, 'vscode__read_file');
    assert.equal(list[0].description, 'Read a file.');
    assert.deepEqual(list[0].inputSchema, { type: 'object' });
    assert.equal(list[1].inputSchema.type, 'object');
    assert.match(list[1].description, /vscode__run/);
});

test('the MCP server shows the tools of the clients of the bus', async () => {
    const hub = createHub({ token: TOKEN });
    await client(hub, 'vscode');
    const server = createMcpServer({
        root: process.cwd(),
        listClientTools: () => hub.listClientTools(),
        callClientTool: (name, args) => hub.callClientTool(name, args),
    });

    const answer = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = answer.result.tools.map((tool) => tool.name);
    assert.ok(names.includes('read_file'));
    assert.ok(names.includes('vscode__read_file'));
    const clientTool = answer.result.tools.find((tool) => tool.name === 'vscode__read_file');
    assert.equal(clientTool.description, 'Read a file of the workspace.');
    assert.deepEqual(clientTool.inputSchema, { type: 'object', properties: { path: { type: 'string' } } });
});

test('the MCP server calls a tool of a client of the bus', async () => {
    const hub = createHub({ token: TOKEN });
    const { socket, transport } = await client(hub, 'vscode');
    const server = createMcpServer({
        root: process.cwd(),
        listClientTools: () => hub.listClientTools(),
        callClientTool: (name, args) => hub.callClientTool(name, args),
    });

    const answer = server.handle({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'vscode__read_file', arguments: { path: 'notes.md' } },
    });
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
    assert.equal(result.id, 7);
    assert.equal(result.result.isError, false);
    assert.equal(result.result.content[0].text, 'the content of the file');
});

test('a tool of a client that is gone is a failure, not a crash', async () => {
    const hub = createHub({ token: TOKEN });
    const { socket } = await client(hub, 'vscode');
    const server = createMcpServer({
        root: process.cwd(),
        listClientTools: () => hub.listClientTools(),
        callClientTool: (name, args) => hub.callClientTool(name, args),
    });

    hub.disconnect(socket);

    const answer = await server.handle({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'vscode__read_file', arguments: {} },
    });
    // The catalog of the client is gone with the client: the tool is not published.
    assert.equal(answer.error.code, -32602);
    assert.match(answer.error.message, /no tool named/i);
});

test('a client that answers late is a failure, not a crash', async () => {
    const hub = createHub({ token: TOKEN });
    await client(hub, 'vscode');
    const server = createMcpServer({
        root: process.cwd(),
        timeoutMs: 30,
        listClientTools: () => hub.listClientTools(),
        callClientTool: (name, args) => hub.callClientTool(name, args, { timeoutMs: 30 }),
    });

    const answer = await server.handle({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: { name: 'vscode__read_file', arguments: {} },
    });
    assert.equal(answer.error.code, -32001);
    assert.match(answer.error.message, /did not finish/i);
});

test('a tool that nobody published is refused', async () => {
    const server = createMcpServer({ root: process.cwd() });
    const answer = await server.handle({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'vscode__read_file', arguments: {} },
    });
    assert.equal(answer.error.code, -32602);
    assert.match(answer.error.message, /no tool named/i);
});

test('the server without a bus shows only the tools of the package', async () => {
    const server = createMcpServer({ root: process.cwd() });
    const answer = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = answer.result.tools.map((tool) => tool.name);
    assert.ok(names.includes('read_file'));
    assert.ok(!names.some((name) => name.includes('__')));
});
