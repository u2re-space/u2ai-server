/**
 * @file src/openai/client.js
 * @module openai/client
 * @purpose API client: the Responses API first, Chat Completions as the transport fallback,
 *          backend rotation with retries.
 *
 * The transport is the global `fetch` of Node: the server keeps no sockets of its own, so a
 * stopped server leaves nothing behind.
 *
 * @depends node:crypto, node:timers/promises, openai/http, openai/fetch, openai/responses,
 *          openai/chat
 * @usedBy cli, server/u2ai, agent/autocomplete, roles/index
 * @exports createClient, resolveBackends, ApiError, retryDelayMs
 * @ai.tags openai, client, api
 * @ai.hint io
 */

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { ApiError, normalizeBaseURL, normalizeHeaders, retryDelayMs, apiErrorFrom } from './http.js';
import { createTransport, readBody, parseSSE } from './fetch.js';
import { buildResponsesBody, createStreamReducer } from './responses.js';
import {
    CHAT_PATH,
    chatGaps,
    createChatStreamReducer,
    normalizeChatResult,
    responsesRouteUnsupported,
    stripRejectedFields,
    toChatBody,
} from './chat.js';
import { resolveModelRef } from '../model/refs.js';

/** Statuses worth another try on the same backend. */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

const limits = Object.freeze({
    maxErrorBytes: 64 * 1024,
    maxResponseBytes: 256 * 1024 * 1024,
    maxEventBytes: 32 * 1024 * 1024,
});

const textOf = (value) => (typeof value === 'string' ? value : '');
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The key of a backend entry: the inline key, then the named environment variable.
 * @param {object} entry
 * @param {Record<string, string|undefined>} env
 * @returns {string|null}
 * @ai.hint pure
 */
function keyOf(entry, env) {
    if (typeof entry?.apiKey === 'string' && entry.apiKey.trim()) return entry.apiKey.trim();
    if (typeof entry?.env === 'string' && entry.env) {
        const value = env?.[entry.env];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
}

/**
 * The ordered backends of one route kind.
 *
 * This package talks to text models: `backends` is the list, and a per-model list in
 * `modelsBackends` wins over the general one (a model is often served by a host that the
 * general list does not know about).
 * @param {object} config
 * @param {{ kind?: 'text', model?: string|null, env?: object }} [options]
 * @returns {Array<{ baseURL: string, apiKey: string|null, headers: object, body: object, supports: object }>}
 * @exports
 */
export function resolveBackends(config, { kind = 'text', model = null, env = process.env } = {}) {
    const general = config?.backends;
    const perModel = model ? config?.modelsBackends?.[model] : null;
    const entries = Array.isArray(perModel) && perModel.length ? perModel : (Array.isArray(general) ? general : []);

    const chain = [];
    for (const entry of entries) {
        if (!isRecord(entry)) continue;
        const baseURL = textOf(entry.baseURL ?? entry.baseUrl).trim();
        if (!baseURL) continue;
        chain.push({
            baseURL,
            apiKey: keyOf(entry, env),
            headers: normalizeHeaders(entry.headers),
            body: isRecord(entry.body) ? { ...entry.body } : {},
            supports: isRecord(entry.supports) ? { ...entry.supports } : {},
        });
    }
    if (chain.some((item) => item.apiKey)) return chain.filter((item) => item.apiKey);

    // No keyed backend: the primary URL and key of the config are the only option left.
    const baseURL = textOf(config?.baseURL).trim();
    if (!baseURL) return chain;
    return [{
        baseURL,
        apiKey: textOf(config?.apiKey).trim() || null,
        headers: {},
        body: {},
        supports: {},
    }, ...chain.filter((item) => item.baseURL !== baseURL)];
}

/**
 * Create an API client for the configured backends.
 *
 * The client owns the transport only: it knows the routes, the retries and the rotation between
 * hosts. What a request means is decided by the caller (the roles, the agent, the bridge).
 * @param {{ config: object, env?: object, signal?: AbortSignal|null, onEvent?: Function|null }} opts
 * @returns {Promise<object>}
 */
export async function createClient({ config, env = process.env, signal = null, onEvent = null } = {}) {
    const transport = createTransport({
        timeoutMs: Number.isSafeInteger(config?.timeoutMs) ? config.timeoutMs : 120_000,
    });
    const retries = Number.isSafeInteger(config?.limits?.requestRetries)
        ? config.limits.requestRetries
        : (Number.isSafeInteger(config?.retries) ? config.retries : 3);
    const announce = (event) => { try { onEvent?.(event); } catch { /* an observer never breaks a request */ } };

    /**
     * Send one request to one backend, with the configured number of retries.
     * @param {object} backend
     * @param {string} path route relative to the base URL
     * @param {{ method?: string, body?: object, rawBody?: Buffer|string, contentType?: string,
     *           signal?: AbortSignal|null, stream?: boolean|str }} options
     * @returns {Promise<{ res: object, backend: object }>}
     * @ai.hint io
     */
    async function send(backend, path, {
        method = 'POST', body = null, rawBody = null, contentType = 'application/json',
        signal: callSignal = null, stream = false,
    } = {}) {
        const root = normalizeBaseURL(backend.baseURL);
        const url = new URL(path, root);
        let attempt = 0;
        for (;;) {
            const clientRequestId = randomUUID();
            const headers = {
                Authorization: `Bearer ${backend.apiKey ?? ''}`,
                'X-Client-Request-Id': clientRequestId,
                ...backend.headers,
            };
            if (rawBody !== null) headers['Content-Type'] = contentType;
            else if (body !== null) headers['Content-Type'] = 'application/json';
            if (stream) headers.Accept = 'text/event-stream';

            let res;
            try {
                res = await transport.request({
                    url,
                    method,
                    headers,
                    body: rawBody !== null ? rawBody : (body !== null ? JSON.stringify(body) : undefined),
                    signal: callSignal ?? signal,
                });
            } catch (error) {
                const wrapped = error instanceof ApiError
                    ? error
                    : new ApiError(`Network error: ${error.message}`, { code: 'NETWORK_ERROR', retryable: true, cause: error });
                if (wrapped.code === 'ABORTED') throw wrapped;
                if (attempt < retries && wrapped.retryable !== false) {
                    const delay = retryDelayMs(attempt, null, null);
                    announce({ type: 'request.retry', attempt: attempt + 1, delayMs: delay, error: wrapped.message });
                    await sleep(delay);
                    attempt += 1;
                    continue;
                }
                throw wrapped;
            }

            if (res.status >= 400) {
                const raw = await readBody(res.body, limits.maxErrorBytes, { truncate: true }).catch(() => Buffer.alloc(0));
                const error = apiErrorFrom({ status: res.status, headers: res.headers, text: raw.toString('utf8'), clientRequestId }, RETRYABLE_STATUS);
                if (attempt < retries && RETRYABLE_STATUS.has(res.status)) {
                    const delay = retryDelayMs(attempt, error.retryAfter, res.status);
                    announce({ type: 'request.retry', attempt: attempt + 1, delayMs: delay, error: error.message });
                    await sleep(delay);
                    attempt += 1;
                    continue;
                }
                throw error;
            }

            return { res, backend };
        }
    }

    /**
     * Read a JSON answer.
     * @param {AsyncIterable<Uint8Array>|null} body
     * @returns {Promise<object>}
     * @ai.hint io
     */
    async function readJson(body) {
        const raw = await readBody(body, limits.maxResponseBytes);
        const text = raw.toString('utf8');
        if (!text.trim()) return {};
        try { return JSON.parse(text); } catch { return { raw: text }; }
    }

    /**
     * Read a streamed answer and reduce it to the final response object.
     * @param {AsyncIterable<Uint8Array>|null} body
     * @param {{ kind: 'responses'|'chat', model: string|null, onEvent?: Function|null }} options
     * @returns {Promise<object>}
     * @ai.hint io
     */
    async function readStream(body, { kind, model, onEvent: streamEvent = null }) {
        const reducer = kind === 'chat'
            ? createChatStreamReducer({ emit: streamEvent ?? (() => {}), model })
            : createStreamReducer({ emit: streamEvent ?? (() => {}) });
        for await (const event of parseSSE(body, { maxEventBytes: limits.maxEventBytes, requireType: kind !== 'chat' })) {
            reducer.handle(event);
        }
        if (reducer.streamError) throw reducer.streamError;
        return reducer.response;
    }

    /**
     * Call one route on one backend, without the rotation.
     * The channels below need it: a task id belongs to the host that created it.
     * @param {object} backend
     * @param {string} path route relative to the base URL
     * @param {{ method?: string, body?: object, rawBody?: Buffer|string, contentType?: string,
     *           signal?: AbortSignal|null, stream?: boolean|str, onEvent?: Function|null,
     *           model?: string|null, raw?: boolean }} options
     * @returns {Promise<object|string>}
     * @ai.hint io
     */
    async function callBackend(backend, path, {
        method = 'POST', body = null, rawBody = null, contentType = 'application/json',
        signal: callSignal = null, stream = false, onEvent: callEvent = null, model = null, raw = false,
    } = {}) {
        announce({ type: 'request.start', backend: backend.baseURL, path, model });
        const { res } = await send(backend, path, {
            method, body, rawBody, contentType, signal: callSignal, stream,
        });
        if (stream) {
            return await readStream(res.body, { kind: stream === 'chat' ? 'chat' : 'responses', model, onEvent: callEvent });
        }
        if (raw) {
            const bytes = await readBody(res.body, limits.maxResponseBytes);
            return bytes.toString('utf8');
        }
        return await readJson(res.body);
    }

    /**
     * Call a route, rotating over the backends of the kind.
     * @param {string} path
     * @param {object} options
     * @returns {Promise<object|string>}
     * @ai.hint io
     */
    async function call(path, {
        method = 'POST', body = null, rawBody = null, contentType = 'application/json',
        kind = 'text', model = null, signal: callSignal = null, stream = false,
        onEvent: callEvent = null, supports = null, raw = false,
    } = {}) {
        const chain = resolveBackends(config, { kind, model, env });
        if (!chain.length) {
            throw new ApiError('No backend is configured for this request.', { code: 'NO_BACKEND' });
        }
        let lastError = null;
        for (const backend of chain) {
            if (supports && backend.supports?.[supports] === false) {
                announce({ type: 'request.skip', backend: backend.baseURL, reason: `no ${supports} route` });
                continue;
            }
            try {
                return await callBackend(backend, path, {
                    method, body, rawBody, contentType, signal: callSignal, stream, onEvent: callEvent, model, raw,
                });
            } catch (error) {
                lastError = error;
                announce({ type: 'request.error', backend: backend.baseURL, status: error?.status ?? null, error: error.message });
                if (error?.code === 'ABORTED') throw error;
                // A host without the route is not a host to retry: the caller picks another transport.
                if (supports === 'responses' && responsesRouteUnsupported(error)) break;
                // Otherwise the next backend gets the request.
            }
        }
        throw lastError ?? new ApiError('No backend answered the request.', { code: 'NO_BACKEND' });
    }

    /**
     * The Responses API with a Chat Completions fallback for hosts without the route.
     * @param {object} params
     * @returns {Promise<object>} the answer in the Responses shape
     */
    async function responsesCreate({
        model = null, instructions = null, input = null, parts = null, tools = null,
        schema = null, schemaName = 'response', schemaChannel = 'auto', strict = true, effort = null,
        summary = null, mode = null, maxOutputTokens = null, temperature = null, store = false,
        truncation = null, verbosity = null, stream = false, signal: callSignal = null,
        onEvent: callEvent = null, previousResponseId = null, toolChoice = null,
        parallelToolCalls = null,
    } = {}) {
        const body = buildResponsesBody({
            model: resolveModelRef(model ?? config?.model ?? null, config), instructions, input, parts, tools, schema, schemaName, schemaChannel, strict,
            effort, summary, mode, maxOutputTokens, temperature, store, truncation, verbosity, stream,
            previousResponseId, toolChoice, parallelToolCalls,
        });
        const wantedModel = resolveModelRef(model ?? config?.model ?? null, config);

        try {
            return await call('responses', {
                method: 'POST', body, kind: 'text', model: wantedModel, signal: callSignal,
                stream: stream ? 'responses' : false, onEvent: callEvent, supports: 'responses',
            });
        } catch (error) {
            if (!responsesRouteUnsupported(error)) throw error;
            const gaps = chatGaps(body);
            if (gaps.length) {
                announce({ type: 'transport.fallback', reason: `the host has no Responses API; dropped: ${gaps.join(', ')}` });
            }
            const chatBody = toChatBody(body);
            try {
                const answer = await call(CHAT_PATH, {
                    method: 'POST', body: chatBody, kind: 'text', model: wantedModel, signal: callSignal,
                    stream: stream ? 'chat' : false, onEvent: callEvent, supports: 'chat',
                });
                return normalizeChatResult(answer, { model: wantedModel });
            } catch (chatError) {
                // A strict gateway may refuse one optional field: drop it and repeat once.
                const { body: stripped, removed } = stripRejectedFields(chatBody, chatError);
                if (!removed.length) throw chatError;
                announce({ type: 'request.adjust', removed });
                const answer = await call(CHAT_PATH, {
                    method: 'POST', body: stripped, kind: 'text', model: wantedModel, signal: callSignal,
                    stream: stream ? 'chat' : false, onEvent: callEvent, supports: 'chat',
                });
                return normalizeChatResult(answer, { model: wantedModel });
            }
        }
    }

    return {
        /**
         * The Responses API.
         */
        responses: {
            create: responsesCreate,
        },

        /**
         * The Chat Completions API, for hosts that serve only that route.
         */
        chat: {
            /**
             * @param {{ model?: string|null, messages?: object[], stream?: boolean, signal?: AbortSignal|null, onEvent?: Function|null }} params
             * @returns {Promise<object>}
             */
            async create({ model = null, messages = [], stream = false, signal: callSignal = null, onEvent: callEvent = null } = {}) {
                const body = { model: resolveModelRef(model ?? config?.model ?? null, config), messages };
                const answer = await call(CHAT_PATH, {
                    method: 'POST', body, kind: 'text', model: body.model, signal: callSignal,
                    stream: stream ? 'chat' : false, onEvent: callEvent, supports: 'chat',
                });
                return normalizeChatResult(answer, { model: body.model });
            },
        },

        /**
         * The Decisions API: probabilities for noul, choice and score questions.
         */
        decisions: {
            /**
             * @param {object} body the body of the request
             * @param {{ signal?: AbortSignal|null, model?: string|null }} [options]
             * @returns {Promise<object>}
             */
            async create(body, { signal: callSignal = null, model = null } = {}) {
                return call('decisions', {
                    method: 'POST', body, kind: 'text', model: model ?? body?.model ?? null,
                    signal: callSignal, supports: 'decisions',
                });
            },
        },

        /**
         * The models route, for diagnostics.
         */
        models: {
            /**
             * @param {{ signal?: AbortSignal|null }} [params]
             * @returns {Promise<object>}
             */
            async list({ signal: callSignal = null } = {}) {
                return call('models', { method: 'GET', kind: 'text', signal: callSignal });
            },
        },

        /**
         * The backends of one route kind as sticky channels.
         *
         * A channel talks to one host and never rotates, which is what an asynchronous task
         * needs: the task id belongs to the host that created it, so the task is polled there.
         * @param {'text'} kind
         * @param {string|null} model the model the request names; a per-model list wins
         * @returns {Array<{ label: string, baseURL: string, call: Function }>}
         */
        channels(kind = 'text', model = null) {
            return resolveBackends(config, { kind, model, env }).map((backend) => ({
                label: backend.baseURL,
                baseURL: backend.baseURL,
                call: (path, options = {}) => callBackend(backend, path, options),
            }));
        },

        /**
         * The backends in use, for diagnostics and dry runs.
         * @returns {Array<{ baseURL: string, apiKey: string|null, supports: object }>}
         */
        backends({ kind = 'text', model = null } = {}) {
            return resolveBackends(config, { kind, model, env });
        },

        /**
         * Close the transport. The global fetch keeps no socket of ours, so there is nothing
         * to release — the method exists for the callers that expect it.
         * @returns {void}
         * @ai.hint io
         */
        close() {},
    };
}

export { ApiError, retryDelayMs };
