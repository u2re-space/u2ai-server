/**
 * @file test/subagent.test.js
 * @module test/subagent
 * @purpose The tests of the hand-over in the server: the inherited role, the tools of the
 *          run, the separate thread, the files that come back and the API data that are
 *          inherited.
 * @depends node:test, node:fs/promises, agent/subagent, server/agent, server/u2ai
 * @ai.tags test, subagent, server, threads
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    SERVER_SUBAGENTS,
    SERVER_SUBAGENT_NAMES,
    subagentToolNames,
    subagentNote,
    createSubagentSpawner,
} from '../src/agent/subagent.js';

/**
 * The fake API of the house: it answers like the model, one turn per request.
 * @param {Array<{ type?: string, name?: string, arguments?: object, text?: string }>} turns
 * @returns {Promise<{ url: string, requests: object[], stop: Function }>}
 */
async function startFakeApi(turns = []) {
    const requests = [];
    const server = createServer((request, response) => {
        let body = '';
        request.on('data', (chunk) => { body += chunk; });
        request.on('end', () => {
            let parsed = {};
            try { parsed = body ? JSON.parse(body) : {}; } catch { parsed = {}; }
            requests.push(parsed);
            const turn = turns[Math.min(requests.length - 1, Math.max(0, turns.length - 1))] ?? { text: 'done' };
            const answer = turn.type === 'function_call'
                ? {
                    status: 'completed',
                    output: [{
                        type: 'function_call',
                        id: `fc-${requests.length}`,
                        call_id: `c-${requests.length}`,
                        name: turn.name,
                        arguments: JSON.stringify(turn.arguments ?? {}),
                    }],
                }
                : { status: 'completed', output_text: turn.text ?? '' };
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify(answer));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        url: `http://127.0.0.1:${server.address()?.port ?? 0}/v1`,
        requests,
        stop() { server.close(); },
    };
}

test('the roles a sub-agent of the server may inherit are known', () => {
    for (const name of ['analyzer', 'director', 'executor']) {
        assert.ok(SERVER_SUBAGENTS[name], name);
        assert.ok(SERVER_SUBAGENTS[name].description.length > 20, name);
        assert.ok(SERVER_SUBAGENTS[name].maxTurns > 0, name);
    }
    // The roles of the whole run are not there: they work once, not by a piece.
    for (const name of ['tooler', 'suggester']) {
        assert.equal(SERVER_SUBAGENTS[name], undefined, name);
    }
    assert.deepEqual([...SERVER_SUBAGENT_NAMES], ['analyzer', 'director', 'executor']);
});

test('the tools of a sub-agent are the tools of the run, cut by the role', () => {
    const runTools = ['list_files', 'read_file', 'write_file', 'run_command', 'subagent'];
    // The executor takes the tools of the run, without the hand-over itself.
    const hands = subagentToolNames('executor', runTools, (role) => (
        role === 'executor' ? runTools.filter((tool) => tool !== 'run_command') : []
    ));
    assert.deepEqual(hands, ['list_files', 'read_file', 'write_file']);
    // A role the registry does not know has no tools.
    assert.deepEqual(subagentToolNames('nope', runTools, () => runTools), []);
});

test('the rule of the hand-over names the roles of the server', () => {
    const note = subagentNote(SERVER_SUBAGENT_NAMES);
    assert.match(note, /sub-agent/);
    assert.match(note, /analyzer/);
    assert.match(note, /director/);
    assert.match(note, /executor/);
    assert.equal(subagentNote([]), '');
});

test('a hand-over without a concrete output file is refused before the worker starts', async () => {
    let started = false;
    const spawn = createSubagentSpawner({
        root: process.cwd(),
        executor: async () => { started = true; return ''; },
        instructions: 'You are the executor.',
    });
    await assert.rejects(
        () => spawn({ role: 'executor', task: 'Make a feature.' }),
        /выходные файлы/,
    );
    assert.equal(started, false);
});

test('a hand-over to a role the server does not know is refused', async () => {
    const spawn = createSubagentSpawner({
        root: process.cwd(),
        executor: async () => '',
        instructions: 'You are the executor.',
    });
    await assert.rejects(
        () => spawn({ role: 'styler', task: 'Fix the styles.', files: ['a.scss'] }),
        /неизвестная роль/,
    );
});

test('the sub-agent works in a thread of the server and the server runs its tools', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-serve-subagent-thread-'));
    const events = [];
    const calls = [];
    const api = await startFakeApi([
        { type: 'function_call', name: 'read_file', arguments: { path: 'note.txt' } },
        { type: 'function_call', name: 'write_file', arguments: { path: 'found.md', content: 'the note\n' } },
        { text: 'The note is copied.' },
    ]);
    try {
        await writeFile(path.join(root, 'note.txt'), 'the note of the server\n', 'utf8');
        const spawn = createSubagentSpawner({
            root,
            config: { baseURL: api.url, apiKey: 'test-key' },
            notify: (event) => events.push(event),
            // The executor of the server: the same road the tools of the run take.
            executor: async (name, args) => {
                calls.push(name);
                if (name === 'read_file') {
                    return await readFile(path.join(root, args.path), 'utf8');
                }
                if (name === 'write_file') {
                    await writeFile(path.join(root, args.path), args.content ?? '', 'utf8');
                    return `Written: ${args.path}`;
                }
                return 'The tool did nothing.';
            },
            instructions: 'You are the executor of a project.',
            toolNamesFor: () => ['read_file', 'write_file'],
            specs: ['read_file', 'write_file'],
        });
        const report = await spawn({
            role: 'executor',
            task: 'Read the note and copy it into found.md.',
            files: ['found.md'],
        });
        assert.match(report, /VERIFIED/);
        assert.deepEqual(calls, ['read_file', 'write_file']);
        // The file of the goal is on the disk.
        const written = await readFile(path.join(root, 'found.md'), 'utf8');
        assert.match(written, /the note/);
        // The run knows about the sub-agent: it starts and it ends.
        assert.ok(events.some((event) => event.type === 'subagent.start'));
        const done = events.find((event) => event.type === 'subagent.done');
        assert.equal(done.ok, true);
        assert.deepEqual(done.files, ['found.md']);
        // The instructions of the hand-over went to the model.
        assert.match(api.requests[0]?.instructions ?? '', /executor of a project/);
    } finally {
        api.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('the sub-agent inherits the API data of the run, and a named one wins', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-serve-subagent-api-'));
    const api = await startFakeApi([{ text: 'done' }]);
    try {
        await writeFile(path.join(root, 'out.txt'), '', 'utf8');
        const spawn = createSubagentSpawner({
            root,
            config: { baseURL: api.url, apiKey: 'run-key' },
            executor: async () => 'ok',
            instructions: 'You are the analyzer.',
            model: 'run-model',
            effort: 'medium',
        });
        // The run of the sub-agent goes to the fake API: the endpoint and the key of the
        // run are the ones the sub-agent talks to.
        await spawn({ role: 'analyzer', task: 'Look.', files: ['out.txt'] });
        assert.equal(api.requests.length, 1);
        assert.equal(api.requests[0].model, 'run-model');
        assert.equal(api.requests[0].reasoning?.effort ?? api.requests[0].effort, 'medium');
    } finally {
        api.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('the agent of the bus hands work to a sub-agent and the report goes back to the model', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-serve-subagent-bus-'));
    const api = await startFakeApi([
        // The turns of the sub-agent: it writes the file and reports.
        { type: 'function_call', name: 'write_file', arguments: { path: 'summary.md', content: 'the summary\n' } },
        { text: 'The summary is written.' },
    ]);
    try {
        const events = [];
        const spawn = createSubagentSpawner({
            root,
            config: { baseURL: api.url, apiKey: 'test-key' },
            notify: (event) => events.push(event),
            // The executor of the server: the same road the tools of the run take — the
            // hub runs the tool, the holder of the tool or the server itself.
            executor: async (name, args) => {
                if (name === 'write_file') {
                    await writeFile(path.join(root, args.path), args.content ?? '', 'utf8');
                    return `Written: ${args.path}`;
                }
                return '';
            },
            instructions: 'You are the executor of a project.',
            toolNamesFor: () => ['write_file'],
            specs: ['write_file'],
        });
        const report = await spawn({
            role: 'executor',
            task: 'Write the summary into summary.md.',
            files: ['summary.md'],
        });
        // The report names the verified file: this is the text the model of the run reads
        // as the output of the `subagent` call.
        assert.match(report, /VERIFIED/);
        assert.match(report, /summary\.md/);
        const written = await readFile(path.join(root, 'summary.md'), 'utf8');
        assert.match(written, /summary/);
        assert.ok(events.some((event) => event.type === 'subagent.start'));
        assert.ok(events.some((event) => event.type === 'subagent.done' && event.ok === true));
        // The instructions of the hand-over went to the model of the sub-agent.
        assert.match(api.requests[0]?.instructions ?? '', /executor of a project/);
    } finally {
        api.stop();
        await rm(root, { recursive: true, force: true });
    }
});
