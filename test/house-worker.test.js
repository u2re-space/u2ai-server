import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';

import { runServerWorker, spawnServerWorker } from '../src/agent/worker-runner.js';
import { normalizeServerSpec, runServerCycle, SERVER_WORKER_TOOLS } from '../src/agent/worker.js';
import { createSharedBlock, readSharedBlock } from '../src/shared/house/shared.js';
import { createRamdisk, createRamdiskFileSystem, createSharedByteCache, allocateMemory } from '../src/access/ramdisk.js';
import { bytesFrame, base64Frame, bytesOfFrame, bytesOf, base64Bytes, isFrame, createFrame } from '../src/shared/house/protocol.js';

/**
 * The API of the test: the worker of the server talks to it over the network, exactly as
 * it talks to the API of the house.
 * @param {object[]} seen the answers the fake API gave
 * @returns {Promise<{ server: object, port: number }>}
 */
async function fakeApi(seen) {
    const server = createServer((request, response) => {
        let body = '';
        request.on('data', (chunk) => { body += chunk; });
        request.on('end', () => {
            seen.push(JSON.parse(body));
            const answer = seen.length === 1
                ? {
                    status: 'completed',
                    output: [{
                        type: 'function_call',
                        id: 'fc-1',
                        call_id: 'c-1',
                        name: 'read_file',
                        arguments: JSON.stringify({ path: 'note.txt' }),
                    }],
                }
                : { status: 'completed', output_text: 'The note is read.' };
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify(answer));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, port: server.address().port };
}

test('the spec of the server worker has every field', () => {
    const spec = normalizeServerSpec({
        role: { name: 'executor', instructions: 'You are the executor.', tools: ['read_file'] },
        goal: 'Read the note.',
        files: ['note.txt'],
        budget: { maxTurns: 4 },
    });
    assert.equal(spec.role.name, 'executor');
    assert.equal(spec.role.instructions, 'You are the executor.');
    assert.deepEqual(spec.role.tools, ['read_file']);
    assert.equal(spec.goal, 'Read the note.');
    assert.deepEqual(spec.files, ['note.txt']);
    assert.equal(spec.budget.maxTurns, 4);
    // The tools of the parent are the tools of the worker: without a list, it has them all.
    const bare = normalizeServerSpec({ role: { name: 'executor' } });
    assert.deepEqual(bare.role.tools, [...SERVER_WORKER_TOOLS]);
});

test('the worker runs in a thread of the parent and calls its tools', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-serve-worker-'));
    const seen = [];
    const { server, port } = await fakeApi(seen);
    const calls = [];
    const events = [];
    try {
        const report = await runServerWorker({
            spec: {
                name: 'executor-1',
                role: { name: 'executor', instructions: 'You are the executor.', tools: ['read_file'] },
                goal: 'Read the note.',
                files: ['note.txt'],
                model: { model: 'test-model', baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key' },
            },
            onCall: async (call) => {
                calls.push(call.name);
                return 'the note of the server';
            },
            onEvent: (event) => events.push(event),
        });
        assert.equal(report.ok, true);
        assert.equal(report.turns, 2);
        assert.deepEqual(calls, ['read_file']);
        assert.ok(events.some((event) => event?.status === 'working'));
        // The thread asked the API of the house with its own model.
        assert.equal(seen[0].model, 'test-model');
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await rm(root, { recursive: true, force: true });
    }
});

test('the instructions of the worker travel in the shared memory', async () => {
    const { buffer } = createSharedBlock({
        instructions: 'You are the executor of the shared buffer.',
        notes: 'The notes of the shared buffer.',
    });
    const bodies = [];
    const client = {
        responses: {
            async create(body) {
                bodies.push(body);
                return { status: 'completed', output_text: 'The note is read.' };
            },
        },
    };
    const report = await runServerCycle({
        spec: {
            role: { name: 'executor', instructions: 'The instructions of the spec.' },
            goal: 'Read the note.',
            context: { notes: 'The notes of the spec.' },
            shared: buffer,
        },
        client,
    });
    assert.equal(report.ok, true);
    // The instructions came from the shared buffer, not from the spec.
    assert.equal(bodies[0].instructions, 'You are the executor of the shared buffer.');
});

test('the worker stops when the parent sets the flag of the shared memory', async () => {
    const { buffer } = createSharedBlock({ instructions: 'You are the executor.', notes: '' });
    const client = {
        responses: {
            async create() {
                // The parent asks the worker to stop while the turn runs.
                readSharedBlock(buffer).cancel();
                return { status: 'completed', output_text: 'The note is read.' };
            },
        },
    };
    const report = await runServerCycle({
        spec: { role: { name: 'executor' }, goal: 'Read the note.', shared: buffer },
        client,
    });
    assert.equal(report.stopped, 'aborted');
    assert.equal(report.ok, false);
});

test('a worker without a goal or without a role says so', async () => {
    const noGoal = await runServerCycle({ spec: { role: { name: 'executor' } }, client: null });
    assert.equal(noGoal.error, 'no-goal');
    const noRole = await runServerCycle({ spec: { goal: 'Read the note.' }, client: null });
    assert.equal(noRole.error, 'no-role');
    const noClient = await runServerCycle({ spec: { role: { name: 'executor' }, goal: 'Read.' }, client: null });
    assert.equal(noClient.error, 'no-client');
});

test('the worker may be started without waiting for it', async () => {
    const { server, port } = await fakeApi([]);
    try {
        const { handle, done } = spawnServerWorker({
            spec: {
                role: { name: 'executor', instructions: 'You are the executor.' },
                goal: 'Read the note.',
                model: { model: 'test-model', baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key' },
            },
            onCall: async () => 'ok',
        });
        assert.equal(handle.role, 'executor');
        assert.equal(handle.alive(), true);
        const report = await done;
        assert.equal(report.ok, true);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('the ramdisk is a backend of the access and a cache of bytes', async () => {
    const fs = createRamdiskFileSystem();
    const cache = createSharedByteCache({ capacityBytes: 1024 });
    const picture = Buffer.from([1, 2, 3, 4, 5]);

    const written = cache.write(picture);
    assert.equal(written, 5);
    assert.equal(cache.size(), 5);
    // The bytes are read without a copy: the view points into the same buffer.
    assert.equal(cache.read().buffer, cache.buffer);
    // The other side of the same memory sees the same bytes.
    const other = createSharedByteCache({ shared: cache.buffer });
    assert.deepEqual([...other.read()], [1, 2, 3, 4, 5]);

    // The file system of the memory answers in the shape of the facade.
    await fs.writeFile('C:/tmp/note.txt', new Uint8Array([7, 8]));
    assert.deepEqual([...await fs.readFile('C:/tmp/note.txt')], [7, 8]);
    const info = await fs.stat('C:/tmp/note.txt');
    assert.equal(info.isFile, true);
    assert.equal(info.size, 2);
});

test('the run may allocate a block of memory of 1, 2, 4 or 8 GB', () => {
    const GiB = 1024 * 1024 * 1024;
    for (const gigabytes of [1, 2, 4, 8]) {
        const block = allocateMemory({ bytes: gigabytes * GiB });
        assert.equal(block.capacityBytes, gigabytes * GiB);
        assert.ok(block.buffer instanceof SharedArrayBuffer);
    }
    // The ceiling of the package is 8 GB.
    assert.throws(() => allocateMemory({ bytes: 9 * GiB }), /over the ceiling/);
});

test('the bytes travel as a frame without a copy, and as base64 when the buffer cannot move', () => {
    const picture = Buffer.from([9, 8, 7, 6]);
    const { frame, transfer } = bytesFrame(picture, { name: 'logo.png' });
    assert.equal(frame.type, 'bytes');
    assert.equal(frame.length, 4);
    assert.equal(transfer.length, 1);
    assert.deepEqual([...bytesOfFrame(frame)], [9, 8, 7, 6]);

    const text = base64Frame(picture, { name: 'logo.png' });
    assert.equal(text.type, 'base64');
    assert.deepEqual([...bytesOfFrame(text)], [9, 8, 7, 6]);

    // The bytes are read out of every shape.
    assert.deepEqual([...bytesOf(Buffer.from([1, 2]))], [1, 2]);
    assert.deepEqual([...bytesOf(new Uint8Array([3, 4]))], [3, 4]);
    assert.deepEqual([...bytesOf('AAEC')], [0, 1, 2]);
    assert.deepEqual([...base64Bytes('AAEC')], [0, 1, 2]);
});

test('the protocol of the house refuses a frame of another version and an unknown kind', () => {
    assert.equal(isFrame(createFrame('status', { event: {} })), true);
    assert.equal(isFrame({ v: 99, type: 'status' }), false);
    assert.equal(isFrame({ v: 1, type: 'nonsense' }), false);
    assert.equal(isFrame(null), false);
    assert.throws(() => createFrame('nonsense'), /Unknown frame/);
});

test('the ramdisk is one package with the file system and the cache', async () => {
    const ramdisk = createRamdisk({ cacheBytes: 4096 });
    assert.ok(ramdisk.fs);
    assert.ok(ramdisk.cache);
    assert.equal(ramdisk.backend.fs, ramdisk.fs);
});
