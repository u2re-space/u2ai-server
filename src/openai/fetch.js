/**
 * @file src/openai/fetch.js
 * @module openai/fetch
 * @purpose The transport: one request on the global `fetch`, a bounded body reader and the
 *          parser of server-sent events. No SDK, no agent, no connection pool of our own.
 * @depends openai/http
 * @exports createTransport, readBody, parseSSE
 * @ai.tags openai, fetch, sse
 * @ai.hint io
 */

import { ApiError, isAbortError } from './http.js';

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * The transport of the package: a thin layer over the global `fetch`.
 *
 * The global fetch keeps the connection pool of Node itself, which is exactly what a
 * long-lived service wants: no sockets of our own to leak when the server stops.
 * @param {{ timeoutMs?: number }} [options]
 * @returns {{ request: Function }}
 * @exports
 */
export function createTransport({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    return {
        /**
         * Send one request.
         * @param {{ url: URL|string, method?: string, headers?: object, body?: string|Buffer|Uint8Array, signal?: AbortSignal|null }} options
         * @returns {Promise<{ status: number, headers: object, body: AsyncIterable<Uint8Array>|null }>}
         * @ai.hint io
         */
        async request({ url, method = 'POST', headers = {}, body = null, signal = null }) {
            const timeout = AbortSignal.timeout(timeoutMs);
            const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
            let response;
            try {
                response = await fetch(url, {
                    method,
                    headers,
                    body: body ?? undefined,
                    signal: combined,
                    redirect: 'follow',
                });
            } catch (error) {
                if (isAbortError(error) && signal?.aborted) {
                    throw new ApiError('The request was cancelled.', { code: 'ABORTED', cause: error });
                }
                if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
                    throw new ApiError(`The request timed out after ${timeoutMs} ms.`, {
                        code: 'TIMEOUT', retryable: true, cause: error,
                    });
                }
                throw new ApiError(`Network error: ${error.message}`, {
                    code: 'NETWORK_ERROR', retryable: true, cause: error,
                });
            }
            const plain = {};
            for (const [name, value] of response.headers) plain[name] = value;
            return { status: response.status, headers: plain, body: response.body };
        },
    };
}

/**
 * Read a response body into a buffer, with a size cap.
 * @param {AsyncIterable<Uint8Array>|null} body
 * @param {number} maxBytes
 * @param {{ truncate?: boolean }} [options]
 * @returns {Promise<Buffer>}
 * @exports
 * @ai.hint io
 */
export async function readBody(body, maxBytes, { truncate = false } = {}) {
    if (!body) return Buffer.alloc(0);
    const chunks = [];
    let total = 0;
    for await (const chunk of body) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += bytes.length;
        if (total > maxBytes) {
            if (!truncate) {
                throw new ApiError(`The answer is larger than ${maxBytes} bytes.`, { code: 'RESPONSE_LIMIT' });
            }
            chunks.push(bytes.subarray(0, Math.max(0, bytes.length - (total - maxBytes))));
            break;
        }
        chunks.push(bytes);
    }
    return Buffer.concat(chunks);
}

const byteLength = (text) => Buffer.byteLength(text, 'utf8');
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Bounded Server-Sent Events parser over an async iterable of byte chunks.
 *
 * Handles split UTF-8 sequences, CR / LF / CRLF line endings, comments, multiple `data:` lines
 * and a final event without a trailing blank line. Yields parsed JSON events; the literal
 * `[DONE]` sentinel is yielded as `{ type: '__done' }`.
 *
 * `requireType` is true for the Responses API, where every event names itself. Chat Completions
 * chunks carry no `type`, so that transport parses with `requireType: false` and takes the type
 * from the SSE `event:` field when one is present.
 * @param {AsyncIterable<Uint8Array>} source
 * @param {{ maxEventBytes?: number, maxStreamBytes?: number, maxEvents?: number, requireType?: boolean }} [options]
 * @returns {AsyncGenerator<object>}
 * @exports
 * @ai.hint pure
 */
export async function* parseSSE(source, {
    maxEventBytes = 16 * 1024 * 1024, maxStreamBytes = 512 * 1024 * 1024, maxEvents = 1_000_000,
    requireType = true,
} = {}) {
    const decoder = new TextDecoder('utf-8', { fatal: false });
    let streamBytes = 0, events = 0, eventBytes = 0;
    let line = '', lineBytes = 0, skipLF = false;
    let dataLines = [], eventName = '';

    const fail = (message, code = 'INVALID_SSE') => { throw new ApiError(message, { code }); };

    /**
     * Add text to the current line and reject an event that exceeds maxEventBytes.
     * @param {string} fragment
     * @returns {void}
     * @ai.hint pure
     */
    function append(fragment) {
        lineBytes += byteLength(fragment);
        if (lineBytes + eventBytes > maxEventBytes) fail('SSE event exceeds the size limit.', 'EVENT_LIMIT');
        line += fragment;
    }
    /**
     * Finish one event. `[DONE]` becomes `{ type: '__done' }`. Returns null when there is no data.
     * @returns {object|null}
     * @ai.hint pure
     */
    function dispatch() {
        const data = dataLines.length ? dataLines.join('\n') : null;
        const name = eventName;
        dataLines = []; eventName = ''; eventBytes = 0;
        if (data === null) return null;
        if (++events > maxEvents) fail('Too many SSE events.', 'EVENT_COUNT_LIMIT');
        if (data.trim() === '[DONE]') return { type: '__done' };
        let event;
        try { event = JSON.parse(data); } catch { fail('SSE data is not valid JSON.'); }
        if (!isRecord(event)) fail('An SSE event must be a JSON object.');
        if (typeof event.type !== 'string' || !event.type) {
            if (requireType) fail('SSE event without a type field.');
            // A chat.completion.chunk names itself only through the SSE `event:` field, if at all.
            if (name) event.type = name;
        }
        if (name && name !== 'message' && event.type && name !== event.type) {
            fail('The SSE event name does not match the JSON type.');
        }
        return event;
    }
    /**
     * Close the current line: blank dispatches, `:` is a comment, `data` and `event` are stored.
     * @returns {object|null}
     * @ai.hint pure
     */
    function endLine() {
        const current = line;
        eventBytes += lineBytes + 1;
        line = ''; lineBytes = 0;
        if (eventBytes > maxEventBytes) fail('SSE event exceeds the size limit.', 'EVENT_LIMIT');
        if (current === '') return dispatch();
        if (current.startsWith(':')) return null;
        const colon = current.indexOf(':');
        const field = colon < 0 ? current : current.slice(0, colon);
        let value = colon < 0 ? '' : current.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'data') dataLines.push(value);
        else if (field === 'event') eventName = value;
        return null;
    }
    /**
     * Split one decoded chunk on CR, LF, and CRLF and yield each finished event.
     * @param {string} text
     * @returns {Generator<object>}
     * @ai.hint pure
     */
    function* consume(text) {
        let start = 0;
        if (skipLF && text.length) { if (text[0] === '\n') start = 1; skipLF = false; }
        const separators = /[\r\n]/g;
        separators.lastIndex = start;
        let match;
        while ((match = separators.exec(text))) {
            const index = match.index;
            append(text.slice(start, index));
            const event = endLine();
            if (event) yield event;
            start = index + 1;
            if (text[index] === '\r') {
                if (text[start] === '\n') { start++; separators.lastIndex = start; }
                else if (start === text.length) skipLF = true;
            }
        }
        append(text.slice(start));
    }

    for await (const chunk of source) {
        streamBytes += chunk.byteLength ?? chunk.length ?? 0;
        if (streamBytes > maxStreamBytes) fail('SSE stream exceeds the size limit.', 'RESPONSE_LIMIT');
        yield* consume(decoder.decode(chunk, { stream: true }));
    }
    yield* consume(decoder.decode());
    if (line.length) { const event = endLine(); if (event) yield event; }
    const last = dispatch();
    if (last) yield last;
}
