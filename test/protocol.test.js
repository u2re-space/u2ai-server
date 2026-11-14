/**
 * @file test/protocol.test.js
 * @module test/protocol
 * @purpose The frames of the `ai-serve` protocol: the limits, the window of the completion, the
 *          check of the incoming frames and the values that go out.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    MAX_FRAME_BYTES,
    MAX_COMPLETION_CONTEXT_BYTES,
    MAX_COMPLETION_FRAME_BYTES,
    COMMANDS,
    APPROVE_MODES,
    DECISIONS,
    START_FIELDS,
    REJECTED_START_FIELDS,
    FRAME_TYPES,
    EVENT_TYPES,
    completionWindowLines,
} from '../src/shared/protocol.js';
import {
    sanitizeValue,
    encodeFrame,
    errorFrame,
    readyFrame,
    runEventFrame,
    toolExecDoneFrame,
    completionFrame,
    buildCompletionFrame,
} from '../src/shared/encoder.js';
import { decodeFrame, validateFrame, validateStart } from '../src/shared/decoder.js';

test('the limits of the protocol are the ones of the client', () => {
    assert.equal(MAX_FRAME_BYTES, 1_048_576);
    assert.equal(MAX_COMPLETION_CONTEXT_BYTES, 262_144);
    assert.equal(MAX_COMPLETION_FRAME_BYTES, 900_000);
});

test('the commands, the approve modes and the decisions are closed lists', () => {
    assert.deepEqual([...COMMANDS], ['ask', 'run', 'chat', 'image']);
    assert.deepEqual([...APPROVE_MODES], ['ask', 'read', 'write', 'all']);
    assert.deepEqual([...DECISIONS], ['yes', 'no', 'always', 'abort']);
});

test('the fields of a start frame are a closed list', () => {
    assert.ok(START_FIELDS.includes('command'));
    assert.ok(START_FIELDS.includes('processing'));
    assert.ok(!START_FIELDS.includes('background'));
    assert.deepEqual([...REJECTED_START_FIELDS], ['background', 'detach', 'job']);
});

test('the events of a run carry the names the client reads', () => {
    for (const name of ['text.delta', 'tool.exec.start', 'tool.exec.done', 'reasoning.delta', 'warning', 'error', 'image.saved', 'response.done']) {
        assert.ok(EVENT_TYPES.includes(name), name);
    }
});

test('the window of the cursor has seven radii', () => {
    assert.deepEqual(completionWindowLines(0), [200, 50]);
    assert.deepEqual(completionWindowLines(1), [100, 25]);
    assert.deepEqual(completionWindowLines(6), [0, 0]);
    assert.deepEqual(completionWindowLines(99), [200, 50]);
});

test('a frame of the client is read', () => {
    const answer = decodeFrame(JSON.stringify({ type: 'hello', role: 'client', token: 'abc' }));
    assert.equal(answer.ok, true);
    assert.equal(answer.frame.token, 'abc');
});

test('a broken JSON is refused', () => {
    const answer = decodeFrame('{');
    assert.equal(answer.ok, false);
    assert.equal(answer.code, 'bad_json');
});

test('a frame that is not an object is refused', () => {
    assert.equal(decodeFrame('[]').code, 'bad_request');
    assert.equal(decodeFrame('42').code, 'bad_request');
});

test('a frame without a type is refused', () => {
    assert.equal(decodeFrame('{}').code, 'bad_request');
});

test('an unknown type is refused', () => {
    assert.equal(decodeFrame(JSON.stringify({ type: 'nope' })).code, 'unknown_type');
    assert.ok(FRAME_TYPES.includes('start'));
});

test('a frame bigger than the limit is refused', () => {
    const big = JSON.stringify({ type: 'hello', role: 'client', token: 'x'.repeat(MAX_FRAME_BYTES) });
    assert.equal(decodeFrame(big).code, 'too_large');
});

test('the start frame refuses the fields of a background run', () => {
    for (const field of REJECTED_START_FIELDS) {
        const answer = validateStart({ type: 'start', command: 'ask', prompt: 'x', [field]: true });
        assert.equal(answer.ok, false);
        assert.equal(answer.code, 'invalid_start');
        assert.match(answer.message, new RegExp(field));
    }
});

test('the start frame refuses an unknown field', () => {
    const answer = validateStart({ type: 'start', command: 'ask', prompt: 'x', nope: 1 });
    assert.equal(answer.ok, false);
    assert.match(answer.message, /Unknown field/);
});

test('the start frame needs a known command and a prompt', () => {
    assert.equal(validateStart({ type: 'start', command: 'fly', prompt: 'x' }).code, 'invalid_start');
    assert.equal(validateStart({ type: 'start', command: 'ask' }).code, 'invalid_start');
    assert.equal(validateStart({ type: 'start', command: 'chat' }).ok, true);
});

test('the start frame checks the approve mode and the tools', () => {
    assert.equal(validateStart({ type: 'start', command: 'ask', prompt: 'x', approve: 'maybe' }).code, 'invalid_start');
    assert.equal(validateStart({ type: 'start', command: 'ask', prompt: 'x', approve: 'write' }).ok, true);
    assert.equal(validateStart({ type: 'start', command: 'ask', prompt: 'x', processing: ['nope'] }).code, 'invalid_start');
    assert.equal(validateStart({ type: 'start', command: 'ask', prompt: 'x', processing: ['read_file'] }).ok, true);
});

test('the approve frame takes only the known decisions', () => {
    assert.equal(validateFrame({ type: 'approve', requestId: 'r1', decision: 'yes' }).ok, true);
    assert.equal(validateFrame({ type: 'approve', requestId: 'r1', decision: 'maybe' }).code, 'bad_request');
    assert.equal(validateFrame({ type: 'approve', decision: 'yes' }).code, 'bad_request');
});

test('the answer frame needs a request and a text', () => {
    assert.equal(validateFrame({ type: 'answer', requestId: 'r1', text: 'yes' }).ok, true);
    assert.equal(validateFrame({ type: 'answer', requestId: 'r1', text: 5 }).code, 'bad_request');
});

test('the input frame needs a run', () => {
    assert.equal(validateFrame({ type: 'input', runId: 'run1', text: 'next' }).ok, true);
    assert.equal(validateFrame({ type: 'input', text: 'next' }).code, 'bad_request');
});

test('the complete frame needs an id, a text and a cursor', () => {
    const good = { type: 'complete', id: 'c1', language: 'typescript', content: 'x', cursor: { line: 0, character: 3 } };
    assert.equal(validateFrame(good).ok, true);
    assert.equal(validateFrame({ ...good, id: '' }).code, 'bad_request');
    assert.equal(validateFrame({ ...good, content: null }).code, 'bad_request');
    assert.equal(validateFrame({ ...good, cursor: { line: -1, character: 0 } }).code, 'bad_request');
    assert.equal(validateFrame({ ...good, cursor: { line: 0 } }).code, 'bad_request');
});

test('the values that go out are sanitized', () => {
    const cycle = { name: 'x' };
    cycle.self = cycle;
    let deep = { value: 1 };
    for (let index = 0; index < 12; index += 1) deep = { deep };
    const value = sanitizeValue({
        fn: () => {},
        sym: Symbol('s'),
        big: 10n,
        nan: Number.NaN,
        deep,
        cycle,
        list: [1, 'two', null],
    });
    assert.equal(value.fn, null);
    assert.equal(value.sym, null);
    assert.equal(value.big, '10');
    assert.equal(value.nan, null);
    assert.equal(value.deep.deep.deep.deep.deep.deep.deep.deep, '[deep]');
    assert.equal(value.cycle.self, '[circular]');
    assert.deepEqual(value.list, [1, 'two', null]);
});

test('a long string is cut', () => {
    const value = sanitizeValue('x'.repeat(100), { maxString: 10 });
    assert.equal(value.length, 11);
    assert.ok(value.endsWith('…'));
});

test('the frame is encoded and measured', () => {
    const text = encodeFrame({ type: 'ready', runs: [] });
    assert.deepEqual(JSON.parse(text), { type: 'ready', runs: [] });
    const huge = { type: 'run.event' };
    for (let index = 0; index < 100; index += 1) huge[`k${index}`] = 'x'.repeat(64 * 1024);
    assert.throws(() => encodeFrame(huge), /bigger than/);
});

test('the frames of the server have the expected shape', () => {
    assert.deepEqual(errorFrame('bad_request', 'x'), { type: 'error', code: 'bad_request', message: 'x' });
    assert.equal(readyFrame([]).type, 'ready');
    assert.equal(runEventFrame('r1', { type: 'text.delta', text: 'a' }).type, 'run.event');
    assert.equal(toolExecDoneFrame('r1', { name: 'read_file', ok: true, summary: 'ok' }).ok, true);
    assert.deepEqual(completionFrame('c1', 'text'), { type: 'completion', id: 'c1', text: 'text' });
});

test('a small document goes to the model whole', () => {
    const result = buildCompletionFrame({
        id: 'c1', language: 'javascript', content: 'const a = 1;', cursor: { line: 0, character: 5 },
    });
    assert.equal(result.frame.content, 'const a = 1;');
    assert.deepEqual(result.frame.cursor, { line: 0, character: 5 });
});

test('a big document is cut around the cursor', () => {
    const lines = Array.from({ length: 1000 }, () => 'x'.repeat(300));
    const content = lines.join('\n');
    const result = buildCompletionFrame({ id: 'c1', content, cursor: { line: 500, character: 2 } });
    assert.ok(result.frame.content.length < content.length);
    assert.ok(result.frame.content.includes('line 500') === false);
    assert.ok(result.frame.cursor.line >= 0);
    assert.ok(result.frame.cursor.line <= 250);
});

test('the window shrinks until the frame fits', () => {
    const line = 'x'.repeat(200_000);
    const content = [line, line, line, line, line].join('\n');
    const result = buildCompletionFrame({ id: 'c1', content, cursor: { line: 2, character: 0 } });
    assert.ok(result.frame.content.length < content.length);
    assert.ok(Buffer.byteLength(JSON.stringify(result.frame), 'utf8') <= MAX_COMPLETION_FRAME_BYTES);
    assert.ok(result.frame.content.split('\n').length < 5);
});

test('a line of the cursor that is too long is refused', () => {
    const line = 'x'.repeat(MAX_COMPLETION_FRAME_BYTES + 10);
    const result = buildCompletionFrame({ id: 'c1', content: line, cursor: { line: 0, character: 0 } });
    assert.equal(result.frame, undefined);
    assert.equal(result.error.code, 'too_large');
});
