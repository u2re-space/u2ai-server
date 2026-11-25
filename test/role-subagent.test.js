import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';

import { createRoleSubagentSpawner, ROLE_SUBAGENTS, ROLE_SUBAGENT_NAMES, roleSubagentToolNames, roleSubagentNote } from '../src/agent/role-subagent.js';
import { runRole } from '../src/roles/index.js';

test('the roles a sub-agent of the CLI may inherit are known', () => {
    for (const name of ['analyzer', 'director', 'executor']) {
        assert.ok(ROLE_SUBAGENTS[name], name);
        assert.ok(ROLE_SUBAGENTS[name].description.length > 20, name);
        assert.ok(ROLE_SUBAGENTS[name].maxTurns > 0, name);
    }
    assert.deepEqual([...ROLE_SUBAGENT_NAMES], ['analyzer', 'director', 'executor']);
});

test('the tools of a sub-agent are the tools of the run, cut by the role', () => {
    const runTools = ['list_files', 'read_file', 'write_file', 'subagent'];
    const hands = roleSubagentToolNames('executor', runTools, (role) => (
        role === 'executor' ? runTools.filter((tool) => tool !== 'subagent') : []
    ));
    assert.deepEqual(hands, ['list_files', 'read_file', 'write_file']);
    // A role the registry does not know has no tools.
    assert.deepEqual(roleSubagentToolNames('unknown', runTools), []);
});

test('the rule of the hand-over names the roles of the CLI', () => {
    const note = roleSubagentNote(ROLE_SUBAGENT_NAMES);
    assert.match(note, /analyzer/);
    assert.match(note, /director/);
    assert.match(note, /executor/);
    assert.equal(roleSubagentNote([]), '');
});

test('a hand-over without a concrete output file is refused before the worker starts', async () => {
    const spawn = createRoleSubagentSpawner({ root: process.cwd(), executor: async () => 'x' });
    await assert.rejects(() => spawn({ role: 'executor', task: 'Do it.' }), /output files/);
    await assert.rejects(() => spawn({ role: 'unknown', task: 'Do it.', files: ['a.md'] }), /unknown role/);
    await assert.rejects(() => spawn({ role: 'executor', task: '', files: ['a.md'] }), /task is empty/);
});

test('the sub-agent of the CLI works in a thread and the parent runs its tools', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-serve-role-subagent-'));
    const requests = [];
    const server = createServer((request, response) => {
        let body = '';
        request.on('data', (chunk) => { body += chunk; });
        request.on('end', () => {
            requests.push(JSON.parse(body));
            const turn = requests.length === 1
                ? { status: 'completed', output: [{ type: 'function_call', id: 'fc-1', call_id: 'c-1', name: 'write_file', arguments: JSON.stringify({ path: 'found.md', content: 'the note' }) }] }
                : { status: 'completed', output_text: 'The note is copied.' };
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify(turn));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
        const calls = [];
        const events = [];
        const spawn = createRoleSubagentSpawner({
            root,
            config: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key' },
            notify: (event) => events.push(event),
            executor: async (name, args) => {
                calls.push(name);
                if (name === 'write_file') {
                    await writeFile(path.join(root, args.path), args.content ?? '', 'utf8');
                    return `Written: ${args.path}`;
                }
                return 'nothing';
            },
            instructions: 'You are the executor of a project.',
            toolNamesFor: () => ['read_file', 'write_file'],
            specs: ['read_file', 'write_file'],
        });
        const report = await spawn({
            role: 'executor',
            task: 'Copy the note into found.md.',
            files: ['found.md'],
        });
        assert.match(report, /VERIFIED/);
        assert.deepEqual(calls, ['write_file']);
        // The file of the goal is on the disk.
        assert.match(await readFile(path.join(root, 'found.md'), 'utf8'), /the note/);
        // The run knows about the sub-agent: it starts and it ends.
        assert.ok(events.some((event) => event.type === 'subagent.start'));
        assert.equal(events.find((event) => event.type === 'subagent.done').ok, true);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await rm(root, { recursive: true, force: true });
    }
});

test('the role of the CLI may hand the work to a sub-agent, and the report goes back to the model', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-serve-role-hand-over-'));
    const requests = [];
    const handOver = {
        status: 'completed',
        output: [{
            type: 'function_call',
            id: 'fc-1',
            call_id: 'c-1',
            name: 'subagent',
            arguments: JSON.stringify({ role: 'executor', task: 'Write the summary.', reason: 'a bounded piece', files: ['summary.md'] }),
        }],
    };
    const client = {
        responses: {
            async create(body) {
                requests.push(body);
                return requests.length === 1
                    ? handOver
                    : { status: 'completed', output_text: 'The summary is written.' };
            },
        },
    };
    try {
        const handed = [];
        const out = await runRole('suggester', {
            task: 'Answer about the project.',
            config: {
                baseURL: 'http://127.0.0.1:1/v1',
                apiKey: 'test-key',
                // The tools of the run: the roles use the catalog that the config allows.
                tools: { read: true, write: true, list: true, search: true, subagent: true, allowWrite: true },
            },
            client,
            root,
            subagent: async (args) => {
                handed.push(args.role);
                await writeFile(path.join(root, 'summary.md'), 'the summary\n', 'utf8');
                return 'The output of the sub-agent: VERIFIED.';
            },
        });
        assert.deepEqual(handed, ['executor']);
        // The report of the sub-agent went back to the model as the output of the call.
        const last = requests[requests.length - 1];
        const output = (last.input ?? []).find((item) => item.type === 'function_call_output');
        assert.match(output?.output ?? '', /VERIFIED/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
