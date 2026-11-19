/**
 * @file test/openai.test.js
 * @module test/openai
 * @purpose The OpenAI layer: the body of a request, the parse of an answer, the fallback chain,
 *          the backends, the chat transport, the decisions and the batches.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    buildResponsesBody,
    parseResponse,
    parseJsonText,
    extractToolCalls,
    textPart,
    imagePart,
    functionTool,
    createStreamReducer,
} from '../src/openai/responses.js';
import {
    ApiError,
    normalizeBaseURL,
    normalizeHeaders,
    retryDelayMs,
    apiErrorFrom,
} from '../src/openai/http.js';
import { parseSSE, readBody } from '../src/openai/fetch.js';
import {
    toChatBody,
    fromChatCompletion,
    normalizeChatResult,
    responsesRouteUnsupported,
    stripRejectedFields,
    chatGaps,
    droppedTools,
    CHAT_PATH,
} from '../src/openai/chat.js';
import { fallbackChain, fallbackModels, fallbackWorthy, modelRefusal } from '../src/openai/fallback.js';
import { resolveBackends } from '../src/openai/client.js';
import { buildDecisionBody, parseDecisionAnswer, validateDecisionQuestions } from '../src/openai/decision.js';
import { buildBatchJsonl, parseBatchResults, batchEndpointFor } from '../src/openai/batch.js';
import { getModelProfile, snapEffort, contextBytes, maxOutputFor } from '../src/model/profiles.js';
import { defaults } from '../src/config/defaults.js';

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

test('the body of a request carries the instructions and the input', () => {
    const body = buildResponsesBody({ model: 'some/model', instructions: 'Be brief.', input: 'Hello.' });
    assert.equal(body.model, 'some/model');
    assert.equal(body.instructions, 'Be brief.');
    assert.equal(body.input[0].role, 'user');
    assert.equal(body.input[0].content[0].text, 'Hello.');
});

test('a schema without tools travels as a text format', () => {
    const body = buildResponsesBody({
        model: 'm', input: 'x', schema: { type: 'object', properties: {} }, schemaName: 'answer',
    });
    assert.equal(body.text.format.type, 'json_schema');
    assert.equal(body.text.format.name, 'answer');
    assert.equal(body.tools, undefined);
});

test('a schema with tools travels as a tool', () => {
    const body = buildResponsesBody({
        model: 'm', input: 'x', tools: [functionTool('read', 'Read a file', { type: 'object' })],
        schema: { type: 'object', properties: {} }, schemaName: 'answer',
    });
    assert.equal(body.text, undefined);
    assert.equal(body.tools.length, 2);
    assert.equal(body.tools[1].name, 'answer');
});

test('the schema channel may be forced', () => {
    const body = buildResponsesBody({
        model: 'm', input: 'x', tools: [functionTool('read', 'Read', {})],
        schema: { type: 'object' }, schemaChannel: 'format',
    });
    assert.equal(body.text.format.type, 'json_schema');
    assert.equal(body.tools.length, 1);
});

test('the reasoning block appears only when it is asked for', () => {
    assert.equal(buildResponsesBody({ model: 'm', input: 'x' }).reasoning, undefined);
    const body = buildResponsesBody({ model: 'm', input: 'x', effort: 'high', summary: 'auto' });
    assert.equal(body.reasoning.effort, 'high');
    assert.equal(body.reasoning.summary, 'auto');
});

test('an answer is parsed into text, data and tool calls', () => {
    const raw = {
        id: 'resp_1',
        model: 'some/model',
        status: 'completed',
        output: [
            { type: 'message', content: [{ type: 'output_text', text: 'Hello.' }] },
            { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' },
        ],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    };
    const parsed = parseResponse(raw);
    assert.equal(parsed.text, 'Hello.');
    assert.equal(parsed.toolCalls.length, 1);
    assert.equal(parsed.toolCalls[0].arguments.path, 'a.txt');
    assert.equal(parsed.usage.total, 15);
});

test('a schema answer is the call of the schema tool', () => {
    const raw = {
        output: [{ type: 'function_call', name: 'answer', arguments: '{"ok":true}' }],
    };
    const parsed = parseResponse(raw, { schemaName: 'answer' });
    assert.equal(parsed.schemaAnswer, true);
    assert.deepEqual(parsed.data, { ok: true });
});

test('a refusal is read', () => {
    const raw = { output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No.' }] }] };
    assert.equal(parseResponse(raw).refusal, 'No.');
});

test('the tool calls of an answer are extracted', () => {
    const calls = extractToolCalls({ output: [{ type: 'function_call', name: 'a', arguments: '{}' }] });
    assert.equal(calls[0].name, 'a');
    assert.deepEqual(calls[0].arguments, {});
});

test('a JSON answer is found inside a fence', () => {
    assert.deepEqual(parseJsonText('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(parseJsonText('Here it is: {"a":1} — done'), { a: 1 });
    assert.equal(parseJsonText('nothing here'), null);
});

test('the input parts are built', () => {
    assert.deepEqual(textPart('hi'), { type: 'input_text', text: 'hi' });
    assert.ok(imagePart(Buffer.from('x'), 'image/png').image_url.startsWith('data:image/png;base64,'));
});

test('the stream reducer turns the events into application events', () => {
    const events = [];
    const reducer = createStreamReducer({ emit: (event) => events.push(event) });
    reducer.handle({ type: 'response.created', response: { id: 'resp_1', status: 'in_progress', model: 'm' } });
    reducer.handle({ type: 'response.output_text.delta', delta: 'Hel', item_id: 'msg_1' });
    reducer.handle({ type: 'response.output_text.delta', delta: 'lo', item_id: 'msg_1' });
    assert.equal(reducer.partialText(), 'Hello');
    assert.ok(events.some((event) => event.type === 'text.delta'));
    assert.equal(events.filter((event) => event.type === 'text.delta').length, 2);
});

test('the base URL is normalized', () => {
    assert.equal(normalizeBaseURL('https://example.test/v1').href, 'https://example.test/v1/');
    assert.throws(() => normalizeBaseURL('https://user:pass@example.test/v1'), TypeError);
});

test('the reserved headers are not replaced by a backend', () => {
    const headers = normalizeHeaders({ Authorization: 'nope', 'X-Custom': 'yes', 'Bad Name': 'x' });
    assert.deepEqual(headers, { 'X-Custom': 'yes' });
});

test('the retry delay honors Retry-After', () => {
    assert.equal(retryDelayMs(0, '2'), 2000);
    assert.ok(retryDelayMs(0, null, 429) >= 3000);
    assert.ok(retryDelayMs(0, null, 500) > 0);
});

test('an error of the host carries the status and the code', () => {
    const error = apiErrorFrom({
        status: 429,
        headers: { 'retry-after': '1', 'x-request-id': 'req_1' },
        text: JSON.stringify({ error: { message: 'Too many.', code: 'rate_limit' } }),
    }, RETRYABLE);
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 429);
    assert.equal(error.apiCode, 'rate_limit');
    assert.equal(error.retryable, true);
});

test('the SSE parser reads the events of a stream', async () => {
    const chunks = [
        Buffer.from('data: {"type":"response.created"}\n\n'),
        Buffer.from('data: {"type":"response.output_text.delta","delta":"a"}'),
        Buffer.from('\n\ndata: [DONE]\n\n'),
    ];
    const events = [];
    for await (const event of parseSSE(chunks)) events.push(event);
    assert.equal(events.length, 3);
    assert.equal(events[2].type, '__done');
});

test('the body reader stops at the cap', async () => {
    const body = [Buffer.from('0123456789')];
    const raw = await readBody(body, 4, { truncate: true });
    assert.equal(raw.length, 4);
    await assert.rejects(() => readBody(body, 4), /larger than/);
});

test('the body of a Responses request becomes a chat body', () => {
    const body = buildResponsesBody({
        model: 'm', instructions: 'Be brief.', input: 'Hello.',
        tools: [functionTool('read', 'Read', { type: 'object' })],
    });
    const chat = toChatBody(body);
    assert.equal(chat.messages[0].role, 'system');
    assert.equal(chat.messages[1].role, 'user');
    assert.equal(chat.tools[0].function.name, 'read');
});

test('a chat answer becomes a response', () => {
    const answer = fromChatCompletion({
        id: 'chat_1',
        model: 'm',
        choices: [{ message: { content: 'Hello.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
    assert.equal(answer.output_text, 'Hello.');
    assert.equal(answer.status, 'completed');
    assert.equal(answer.usage.input_tokens, 3);
    assert.equal(normalizeChatResult({ choices: [] }).status, 'completed');
});

test('a host without the Responses route is recognized', () => {
    assert.equal(responsesRouteUnsupported({ status: 404 }), true);
    assert.equal(responsesRouteUnsupported({ status: 400, message: 'unknown route /v1/responses' }), true);
    assert.equal(responsesRouteUnsupported({ status: 404, param: 'model', message: 'model not found' }), false);
});

test('a refused field is dropped and the call may be repeated', () => {
    const { body, removed } = stripRejectedFields(
        { model: 'm', temperature: 0.5, max_completion_tokens: 100 },
        { status: 400, message: 'temperature is not supported' },
    );
    assert.deepEqual(removed, ['temperature']);
    assert.equal(body.temperature, undefined);
    assert.equal(body.max_completion_tokens, 100);
});

test('the chat transport names what it cannot carry', () => {
    const body = buildResponsesBody({
        model: 'm', input: 'x', tools: [{ type: 'web_search' }],
    });
    assert.deepEqual(droppedTools(body.tools), ['web_search']);
    assert.ok(chatGaps(body).includes('web_search'));
    assert.equal(CHAT_PATH, 'chat/completions');
});

test('the fallback chain is the model and then its fallbacks', () => {
    const config = { fallback: { enabled: true, models: { 'a/b': ['c/d'], '*': ['e/f'] } } };
    assert.deepEqual(fallbackModels(config, 'a/b'), ['c/d', 'e/f']);
    assert.deepEqual(fallbackChain(config, 'a/b'), ['a/b', 'c/d', 'e/f']);
    assert.deepEqual(fallbackChain({ fallback: { enabled: false, models: {} } }, 'a/b'), ['a/b']);
});

test('an error of the model is worth another model, an error of the request is not', () => {
    assert.equal(fallbackWorthy({ status: 500 }), true);
    assert.equal(fallbackWorthy({ status: 401 }), false);
    assert.equal(fallbackWorthy({ status: 403, message: 'this model is not allowed for this key' }), true);
    assert.equal(fallbackWorthy({ code: 'ABORTED' }), false);
    assert.equal(modelRefusal({ param: 'model' }), true);
});

test('the backends with a key win, the per-model list wins over the general one', () => {
    const config = {
        baseURL: 'https://primary.test/v1',
        apiKey: 'sk-1',
        backends: [
            { baseURL: 'https://a.test/v1', env: 'A_KEY' },
            { baseURL: 'https://b.test/v1', apiKey: 'sk-b' },
        ],
        modelsBackends: { 'm/1': [{ baseURL: 'https://m.test/v1', apiKey: 'sk-m' }] },
    };
    const general = resolveBackends(config, { env: {} });
    assert.deepEqual(general.map((item) => item.baseURL), ['https://b.test/v1']);
    const perModel = resolveBackends(config, { model: 'm/1', env: {} });
    assert.deepEqual(perModel.map((item) => item.baseURL), ['https://m.test/v1']);
});

test('a backend without a key is used when no backend has one', () => {
    const config = { baseURL: 'https://primary.test/v1', apiKey: null, backends: [{ baseURL: 'https://a.test/v1' }] };
    const chain = resolveBackends(config, { env: {} });
    assert.equal(chain[0].baseURL, 'https://primary.test/v1');
    assert.equal(chain[0].apiKey, null);
});

test('the body of a decision request is checked', () => {
    const body = buildDecisionBody({
        model: 'm',
        state: 'some text',
        questions: { risk: { type: 'noul', instructions: 'Is it risky?', criteria: { true: 'yes', false: 'no' } } },
    });
    assert.equal(body.model, 'm');
    assert.equal(body.questions.risk.type, 'noul');
    assert.throws(() => buildDecisionBody({ model: 'm', state: 'x', questions: {} }), /at least one question/i);
    assert.throws(() => buildDecisionBody({ model: 'm', state: '', questions: { a: { type: 'noul', instructions: 'i', criteria: { true: 'a', false: 'b' } } } }), /state is empty/i);
});

test('the questions of a decision request are checked', () => {
    assert.throws(() => validateDecisionQuestions({ a: { type: 'nope', instructions: 'i', criteria: {} } }), /type is/);
    assert.throws(() => validateDecisionQuestions({ a: { type: 'choice', instructions: 'i', criteria: { only: 'one' } } }), /at least two variants/i);
});

test('the answer of a decision request carries the probabilities', () => {
    const answer = parseDecisionAnswer({ id: 'd_1', answers: { risk: { type: 'noul', noul: 0.2 } } }, { model: 'm' });
    assert.equal(answer.answers.risk.noul, 0.2);
    assert.throws(() => parseDecisionAnswer({}), /no answers/);
});

test('the file of a batch is one request per line', () => {
    const jsonl = buildBatchJsonl([
        { customId: 'a', body: { model: 'm' } },
        { customId: 'b', url: '/v1/responses' },
        { body: {} },
    ]).toString('utf8');
    const lines = jsonl.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).custom_id, 'a');
});

test('the answers of a batch are read by the name of the request', () => {
    const results = parseBatchResults([
        JSON.stringify({ custom_id: 'a', response: { status_code: 200, body: { ok: true } } }),
        JSON.stringify({ custom_id: 'b', error: { message: 'failed' } }),
    ].join('\n'));
    assert.equal(results.get('a').ok, true);
    assert.equal(results.get('b').ok, false);
    assert.match(results.get('b').error, /failed/);
});

test('the route of a batch follows the base URL of the host', () => {
    assert.equal(batchEndpointFor('https://example.test/v1'), '/v1/responses');
    assert.equal(batchEndpointFor('https://example.test/v1', 'chat/completions'), '/v1/chat/completions');
});

test('the profile of the model of the server is known', () => {
    const profile = getModelProfile('minimax/minimax-m3.1-flash');
    assert.ok(profile.window > 0);
    assert.ok(profile.maxOutput > 0);
});

test('the effort is clamped to what the model accepts', () => {
    const profile = getModelProfile('minimax/minimax-m3.1-flash');
    assert.equal(snapEffort('xhigh', profile), 'xhigh');
    assert.equal(snapEffort('low', profile), 'low');
    assert.equal(snapEffort('unknown', profile), null);
});

test('the context budget of a level is read', () => {
    const profile = getModelProfile('minimax/minimax-m3.1-flash');
    assert.equal(contextBytes('auto', profile), profile.window);
    assert.equal(contextBytes('small', profile), 16 * 1024);
    assert.equal(contextBytes(2048, profile), 2048);
});

test('the output cap never exceeds the cap of the model', () => {
    assert.equal(maxOutputFor('minimax/minimax-m3.1-flash', null, 1_000_000), 524288);
});

test('the Gemini is the alternative to the Kimi and the Kimi is the fallback', () => {
    const gemini = getModelProfile('google/gemini-4-hydrogen');
    assert.equal(gemini.ceiling, 'xhigh');
    assert.deepEqual(gemini.efforts, ['low', 'medium', 'high', 'xhigh']);
    assert.equal(snapEffort('none', gemini), 'low', 'the card of the vendor has no none');
    assert.equal(snapEffort('xhigh', gemini), 'xhigh');

    // The Kimi is tuned for the speed of the answer: the ceiling is `medium`.
    const kimi = getModelProfile('moonshotai/kimi-k3.1-pro');
    assert.equal(kimi.ceiling, 'high');
    assert.equal(snapEffort('high', kimi), 'high');
    assert.equal(snapEffort('none', kimi), 'none', 'the reasoning may be turned off');
});

test('the chain of the house starts with the Kimi', () => {
    // The Gemini is the alternative, the Kimi answers when it refuses. The ladder of the
    // family of the Gemini stands at the end of the chain.
    assert.deepEqual(
        fallbackChain(defaults, 'google/gemini-4-hydrogen'),
        [
            'google/gemini-4-hydrogen',
            'moonshotai/kimi-k3.1-pro',
            'moonshotai/kimi-k3',
            'openai/gpt-5.1',
            'google/gemini-4-neon',
        ],
    );
    // Every other model falls back to the Kimi too.
    assert.deepEqual(
        fallbackChain(defaults, 'vendor/other'),
        ['vendor/other', 'moonshotai/kimi-k3.1-pro', 'moonshotai/kimi-k3', 'openai/gpt-5.1'],
    );
});
