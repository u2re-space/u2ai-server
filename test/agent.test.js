/**
 * @file test/agent.test.js
 * @module test/agent
 * @purpose The agent behind the bus: the answer of the model, the tools of the run, the
 *          chat, the pictures, and the end of every run.
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createServerAgent } from '../src/server/agent.js';
import { createHub } from '../src/server/u2ai.js';

const TOKEN = 'secret-token';

// The runs sign the house of the project: the root of the tests is a temporary directory,
// and the package directory stays clean.
const ROOT = await mkdtemp(path.join(os.tmpdir(), 'ai-serve-agent-'));

after(async () => {
    await rm(ROOT, { recursive: true, force: true });
});

/**
 * A response of the model in the shape of the Responses API.
 * @param {string} text
 * @returns {object}
 */
function answerOf(text) {
    return {
        id: 'resp_1',
        status: 'completed',
        model: 'test-model',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
        output_text: text,
        usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
    };
}

/**
 * A call of the model: the answer, and the tools it asks for.
 * @param {string} text
 * @param {Array<{ name: string, arguments?: object }>} [calls]
 * @returns {object}
 */
function rawWithCalls(text, calls = []) {
    const output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }];
    for (const [index, call] of calls.entries()) {
        output.push({
            type: 'function_call',
            id: `fc_${index}`,
            call_id: `call_${index}`,
            name: call.name,
            arguments: JSON.stringify(call.arguments ?? {}),
        });
    }
    return {
        id: 'resp_1',
        status: 'completed',
        model: 'test-model',
        output,
        output_text: text,
        usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
    };
}

/**
 * A client of the API that answers by a list of the answers.
 * @param {object[]} answers the raw answers, one per request
 * @returns {object}
 */
function fakeClient(answers) {
    const calls = [];
    return {
        calls,
        responses: {
            /**
             * @param {object} params
             * @returns {Promise<object>}
             */
            async create(params) {
                const index = calls.length;
                calls.push(params);
                const raw = answers[Math.min(index, answers.length - 1)];
                if (typeof params.onEvent === 'function') {
                    params.onEvent({ type: 'text.delta', text: raw.output_text ?? '' });
                }
                return raw;
            },
        },
    };
}

/**
 * A hub that keeps the events of the runs and the calls of the tools.
 * @param {{ answers?: object[] }} [options]
 * @returns {object}
 */
function fakeHub({ answers = [] } = {}) {
    const events = [];
    const tools = [];
    const finished = [];
    const inputs = [];
    return {
        events,
        tools,
        finished,
        inputs,
        /**
         * @param {string} runId
         * @param {object} event
         * @returns {void}
         */
        publish(runId, event) { events.push({ runId, ...event }); },
        /**
         * @param {string} runId
         * @param {string} name
         * @param {object} args
         * @returns {Promise<object>}
         */
        async runTool(runId, name, args) {
            tools.push({ runId, name, args });
            const answer = answers[Math.min(tools.length - 1, answers.length - 1)] ?? {};
            return {
                ok: true,
                output: answer.output ?? '',
                summary: answer.summary ?? 'done',
                changes: answer.changes ?? [],
                error: null,
            };
        },
        /**
         * @param {string} runId
         * @param {string} status
         * @param {number} [exitCode]
         * @returns {void}
         */
        finish(runId, status, exitCode = 0) { finished.push({ runId, status, exitCode }); },
        /**
         * @param {string} runId
         * @returns {Promise<string|null>}
         */
        async waitInput(runId) {
            inputs.push(runId);
            return null;
        },
    };
}

/**
 * A run and a frame of a client.
 * @param {object} [frame]
 * @returns {{ run: object, frame: object }}
 */
function runOf(frame = {}) {
    return {
        run: { id: 'run-1', cwd: '', controller: new AbortController() },
        frame: { type: 'start', command: 'ask', prompt: 'the question', ...frame },
    };
}

/**
 * The events of one type.
 * @param {object} hub
 * @param {string} type
 * @returns {object[]}
 */
function eventsOf(hub, type) {
    return hub.events.filter((event) => event.type === type);
}

test('the agent answers a question and finishes the run', async () => {
    const hub = fakeHub();
    const client = fakeClient([answerOf('the answer')]);
    const agent = createServerAgent({ hub, config: { model: 'test-model' }, client, root: ROOT });
    const { run, frame } = runOf();
    await agent.start(run, frame);

    assert.equal(eventsOf(hub, 'text.delta').length, 1);
    assert.equal(eventsOf(hub, 'text.delta')[0].text, 'the answer');
    assert.equal(eventsOf(hub, 'text.done')[0].text, 'the answer');
    assert.equal(eventsOf(hub, 'response.done')[0].usage.input, 12);
    assert.deepEqual(hub.finished, [{ runId: 'run-1', status: 'completed', exitCode: 0 }]);
});

test('the question of a client asks the model without the tools', async () => {
    const hub = fakeHub();
    const client = fakeClient([answerOf('the answer')]);
    const agent = createServerAgent({ hub, config: { model: 'test-model' }, client, root: ROOT });
    const { run, frame } = runOf();
    await agent.start(run, frame);

    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].tools, null);
    assert.equal(client.calls[0].stream, true);
    assert.equal(client.calls[0].model, 'test-model');
});

test('the tools of the run go through the hub', async () => {
    const hub = fakeHub({ answers: [{ output: 'the content of the file', summary: 'read 1 file' }] });
    const client = fakeClient([
        rawWithCalls('', [{ name: 'read_file', arguments: { path: 'notes.md' } }]),
        answerOf('the file says hello'),
    ]);
    const agent = createServerAgent({ hub, config: { model: 'test-model' }, client, root: ROOT });
    const { run, frame } = runOf({ command: 'run', prompt: 'read the file' });
    await agent.start(run, frame);

    assert.equal(hub.tools.length, 1);
    assert.equal(hub.tools[0].name, 'read_file');
    assert.deepEqual(hub.tools[0].args, { path: 'notes.md' });
    assert.equal(eventsOf(hub, 'tool.exec.start')[0].name, 'read_file');
    assert.equal(eventsOf(hub, 'tool.exec.done')[0].ok, true);
    assert.equal(eventsOf(hub, 'tool.exec.done')[0].summary, 'read 1 file');
    assert.equal(eventsOf(hub, 'text.done')[0].text, 'the file says hello');
    assert.equal(hub.finished[0].status, 'completed');
});

test('the run carries the catalogue of the installed skills', async () => {
    const skill = path.join(ROOT, '.agents', 'skills', 'oil-ui');
    await mkdir(skill, { recursive: true });
    await writeFile(
        path.join(skill, 'SKILL.md'),
        '---\nname: oil-ui\ndescription: UI design workflow.\n---\nChoose a direction.',
        'utf8',
    );
    const hub = fakeHub();
    const client = fakeClient([answerOf('done')]);
    const agent = createServerAgent({ hub, config: { model: 'test-model' }, client, root: ROOT });
    const { run, frame } = runOf({ command: 'run', prompt: 'polish the interface' });
    await agent.start(run, frame);
    assert.match(client.calls[0].instructions, /oil-ui/);
    assert.match(client.calls[0].instructions, /read_skill/);
});

test('the answer of a tool goes back to the model', async () => {
    const hub = fakeHub({ answers: [{ output: 'the content of the file' }] });
    const client = fakeClient([
        rawWithCalls('', [{ name: 'read_file', arguments: { path: 'notes.md' } }]),
        answerOf('done'),
    ]);
    const agent = createServerAgent({ hub, config: { model: 'test-model' }, client, root: ROOT });
    const { run, frame } = runOf({ command: 'run', prompt: 'read the file' });
    await agent.start(run, frame);

    const second = client.calls[1];
    const output = second.input.find((item) => item.type === 'function_call_output');
    assert.equal(output.output, 'the content of the file');
    assert.equal(output.call_id, 'call_0');
});

test('a client may ask for no tools at all', async () => {
    const hub = fakeHub();
    const client = fakeClient([answerOf('the answer')]);
    const agent = createServerAgent({ hub, config: { model: 'test-model' }, client, root: ROOT });
    const { run, frame } = runOf({ command: 'run', prompt: 'the task', noTools: true });
    await agent.start(run, frame);

    assert.equal(client.calls[0].tools, null);
    assert.equal(hub.tools.length, 0);
});

test('the pictures are refused with a clear warning', async () => {
    const hub = fakeHub();
    const client = fakeClient([answerOf('never used')]);
    const agent = createServerAgent({ hub, config: { model: 'test-model' }, client, root: ROOT });
    const { run, frame } = runOf({ command: 'image', prompt: 'a cat' });
    await agent.start(run, frame);

    assert.equal(eventsOf(hub, 'warning').length, 1);
    assert.match(eventsOf(hub, 'warning')[0].message, /does not generate pictures/);
    assert.equal(hub.finished[0].status, 'failed');
    assert.equal(client.calls.length, 0);
});

test('a failure of the model is an event, not a crash', async () => {
    const hub = fakeHub();
    const client = {
        responses: {
            async create() { throw new Error('the host is down'); },
        },
    };
    const agent = createServerAgent({ hub, config: { model: 'test-model' }, client, root: ROOT });
    const { run, frame } = runOf();
    await agent.start(run, frame);

    assert.equal(eventsOf(hub, 'error').length, 1);
    assert.match(eventsOf(hub, 'error')[0].message, /the host is down/);
    assert.equal(hub.finished[0].status, 'failed');
});

test('the agent answers the runs of the clients of the bus', async () => {
    const client = fakeClient([answerOf('the answer')]);
    let agent = null;
    const hub = createHub({
        token: TOKEN,
        onStart: (run, frame) => agent.start(run, frame),
    });
    agent = createServerAgent({ hub, config: { model: 'test-model' }, client, root: ROOT });

    const frames = [];
    const socket = hub.connect({ send: (frame) => frames.push(frame), close: () => {} });
    await hub.receive(socket, { type: 'hello', role: 'client', token: TOKEN });
    await hub.receive(socket, { type: 'start', command: 'ask', prompt: 'the question' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const events = frames.filter((frame) => frame.type === 'run.event').map((frame) => frame.event);
    assert.ok(events.some((event) => event.type === 'text.delta' && event.text === 'the answer'));
    assert.ok(events.some((event) => event.type === 'response.done'));
    const ended = frames.find((frame) => frame.type === 'run.ended');
    assert.equal(ended.status, 'completed');
});

test('the run signs the house of the project: the state and the contract', async () => {
    const hub = fakeHub({
        answers: [{ output: 'written', summary: 'wrote 1 file', changes: [{ op: 'create', path: 'notes.md' }] }],
    });
    const client = fakeClient([
        rawWithCalls('', [{ name: 'write_file', arguments: { path: 'notes.md' } }]),
        answerOf('the file is written'),
    ]);
    const agent = createServerAgent({ hub, config: { model: 'test-model' }, client, root: ROOT });
    const { run, frame } = runOf({ command: 'run', prompt: 'write the file' });
    await agent.start(run, frame);

    const state = JSON.parse(await readFile(path.join(ROOT, '.ai', 'tmp', 'run-1', 'run.json'), 'utf8'));
    assert.equal(state.status, 'completed');
    assert.deepEqual(state.changes, ['notes.md']);

    const manifest = JSON.parse(await readFile(path.join(ROOT, '.ai', 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.systems.server.artifacts.changes, ['notes.md']);
});
