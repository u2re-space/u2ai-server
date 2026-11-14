/**
 * @file test/stdio.test.js
 * @module test/stdio
 * @purpose The stdio transports of the package: the server one (`server/stdio.js`) and
 *          the client one (`client/stdio.js`).
 *
 *   The transports are the boundary of the package: a line of JSON goes in, a line of
 *   JSON comes out. The tests here hold that boundary: the server answers a line and
 *   stays alive after a broken one, the client starts a child, speaks with it and
 *   reports its death.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { startStdioServer } from '../src/server/stdio.js';
import { startNodeServer } from '../src/client/stdio.js';
import { createMcpServer, MCP_ERROR } from '../src/server/mcp.js';
import { main, EXIT } from '../src/cli.js';

/**
 * A pair of streams and the lines the server writes into the output.
 * @returns {{ input: PassThrough, output: PassThrough, lines: object[] }}
 */
function streams() {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines = [];
    output.on('data', (chunk) => {
        for (const line of String(chunk).split('\n')) {
            if (line.trim()) lines.push(JSON.parse(line));
        }
    });
    return { input, output, lines };
}

/**
 * Wait for a while, so the answer of the transport has the time to come.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

test('the server transport answers a line with a line', async () => {
    const { input, output, lines } = streams();
    const handle = startStdioServer({ server: createMcpServer({}), input, output });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
    await wait(60);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].id, 1);
    assert.deepEqual(lines[0].result, {});
    handle.close();
});

test('the server transport writes nothing for a notification', async () => {
    const { input, output, lines } = streams();
    const handle = startStdioServer({ server: createMcpServer({}), input, output });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    await wait(60);
    assert.equal(lines.length, 0);
    handle.close();
});

test('the server transport survives a broken line', async () => {
    const { input, output, lines } = streams();
    const handle = startStdioServer({ server: createMcpServer({}), input, output });
    input.write('{oops\n');
    await wait(60);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].error.code, MCP_ERROR.parse);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`);
    await wait(60);
    assert.equal(lines.length, 2);
    assert.equal(lines[1].id, 2);
    handle.close();
});

test('the server transport writes nothing after it is closed', async () => {
    const { input, output, lines } = streams();
    const handle = startStdioServer({ server: createMcpServer({}), input, output });
    handle.close();
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' })}\n`);
    await wait(60);
    assert.equal(lines.length, 0);
});

test('the client transport needs the command of the server', async () => {
    await assert.rejects(() => startNodeServer({ command: '  ' }), /command of the MCP server is needed/);
});

test('the client transport starts a child and speaks with it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-serve-stdio-'));
    const file = path.join(dir, 'child.mjs');
    await writeFile(file, `
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
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { echo: message.params.text } }) + '\\n');
  }
});
`, 'utf8');
    const child = await startNodeServer({ command: process.execPath, args: [file] });
    try {
        const answer = await child.transport.send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { text: 'hi' } });
        assert.equal(answer.result.echo, 'hi');
    } finally {
        await child.close();
    }
});

test('the client transport reports the death of the child', async () => {
    const child = await startNodeServer({
        command: process.execPath,
        args: ['-e', 'process.exit(3)'],
    });
    await assert.rejects(
        () => child.transport.send({ jsonrpc: '2.0', id: 8, method: 'ping' }),
        /stopped \(code 3\)/,
    );
    await child.close();
});

test('the command mcp speaks the protocol over stdio', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-serve-stdio-cli-'));
    const bin = path.resolve('bin/ai-serve.js');
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, [bin, 'mcp'], {
        env: { ...process.env, AI_SERVE_HOME: home },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = [];
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
        buffer += chunk;
        for (;;) {
            const index = buffer.indexOf('\n');
            if (index < 0) break;
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (line) lines.push(JSON.parse(line));
        }
    });
    try {
        child.stdin.write(`${JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } },
        })}\n`);
        for (let i = 0; i < 100 && lines.length === 0; i += 1) await wait(30);
        assert.equal(lines.length > 0, true, 'the server did not answer');
        assert.equal(lines[0].result.serverInfo.name, 'ai-serve');
    } finally {
        child.kill();
        await new Promise((resolve) => child.on('close', resolve));
    }
});

test('the exports of the package hold the two transports', async () => {
    const pkg = await import('../index.js');
    assert.equal(typeof pkg.startStdioServer, 'function');
    assert.equal(typeof pkg.startNodeServer, 'function');
    assert.equal(typeof pkg.main, 'function');
    assert.equal(EXIT.ok, 0);
});
