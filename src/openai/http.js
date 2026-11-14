/**
 * @file src/openai/http.js
 * @module openai/http
 * @purpose Pure helpers of the HTTP layer: the error type, the base URL, the headers and
 *          the retry delay. Nothing here touches the network.
 * @exports ApiError, isAbortError, normalizeBaseURL, normalizeHeaders, retryDelayMs, apiErrorFrom
 * @ai.tags openai, http
 * @ai.hint pure
 */

/** Error raised for any failure while talking to the API. */
export class ApiError extends Error {
    /**
     * Copy status, request ids and retry metadata onto the error. The response body
     * is kept only when it is passed in.
     * @param {string} message
     * @param {object} [options]
     * @returns {void}
     * @ai.hint pure
     */
    constructor(message, {
        code = 'API_ERROR', status = null, requestId = null, clientRequestId = null, responseId = null,
        retryAfter = null, apiCode = null, apiType = null, param = null, retryable = false, cause, details = null,
    } = {}) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = 'ApiError';
        Object.assign(this, {
            code, status, requestId, clientRequestId, responseId, retryAfter,
            apiCode, apiType, param, retryable, details,
        });
    }

    /** Response bodies and prompts are deliberately excluded from the log representation. */
    toJSON() {
        return {
            name: this.name, code: this.code, message: this.message, status: this.status,
            requestId: this.requestId, clientRequestId: this.clientRequestId, responseId: this.responseId,
            retryAfter: this.retryAfter, apiCode: this.apiCode, apiType: this.apiType, param: this.param,
            retryable: this.retryable,
        };
    }
}

/**
 * True for an AbortError, ABORT_ERR, or a cancelled request.
 * @param {*} error
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export const isAbortError = (error) =>
    error?.name === 'AbortError' || error?.code === 'ABORT_ERR';

/** Headers the client sets itself; a backend header must not replace them. */
const RESERVED_HEADERS = new Set(['authorization', 'content-type', 'accept', 'x-client-request-id']);

/** RFC 7230 token characters for header names. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const textOf = (value) => (typeof value === 'string' ? value : '');
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Normalize a base URL and require a path that ends with `/`.
 * @param {string} value
 * @returns {URL}
 * @exports
 * @ai.hint pure
 */
export function normalizeBaseURL(value) {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) {
        throw new TypeError('The base URL must not contain credentials, a query or a fragment.');
    }
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url;
}

/**
 * Stringify and check per-backend headers. Reserved names are ignored: auth and content
 * headers belong to the client.
 * @param {object|null|undefined} headers
 * @returns {Record<string, string>}
 * @exports
 * @ai.hint pure
 */
export function normalizeHeaders(headers) {
    if (!isRecord(headers)) return {};
    const out = {};
    for (const [name, value] of Object.entries(headers)) {
        if (!HEADER_NAME.test(name) || RESERVED_HEADERS.has(name.toLowerCase()) || value == null) continue;
        const text = String(value);
        if (/[\r\n]/.test(text)) throw new TypeError(`Header ${name} contains a line break.`);
        out[name] = text;
    }
    return out;
}

/**
 * Delay before a retry. A positive Retry-After wins, capped at 60 seconds; otherwise backoff
 * with jitter. HTTP 429 waits at least 3 seconds so a repeat does not look like a burst.
 * @param {number} attempt
 * @param {string|number|null} retryAfter
 * @param {number|null} [status]
 * @returns {number}
 * @exports
 * @ai.hint pure
 */
export function retryDelayMs(attempt, retryAfter, status = null) {
    const header = Number(retryAfter);
    const fromHeader = Number.isFinite(header) && header > 0 ? Math.min(header * 1000, 60_000) : 0;
    const backoff = Math.min(500 * 2 ** attempt + Math.random() * 250, 20_000);
    const delay = Math.max(fromHeader, backoff);
    if (status === 429) return Math.max(delay, 3000);
    return fromHeader > 0 ? fromHeader : backoff;
}

/**
 * Build an ApiError out of a failed answer.
 * @param {{ status: number, headers?: object, text?: string, clientRequestId?: string|null }} res
 * @param {Set<number>} retryableStatus
 * @returns {ApiError}
 * @exports
 * @ai.hint pure
 */
export function apiErrorFrom(res, retryableStatus) {
    const headers = res.headers ?? {};
    const text = textOf(res.text).trim();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    const err = isRecord(parsed) ? (parsed.error ?? parsed) : null;
    const details = isRecord(err) ? err : {};
    const fromBody = typeof err === 'string' ? err : textOf(details.message);
    const message = (fromBody || text).slice(0, 2000) || `HTTP ${res.status}`;
    return new ApiError(message, {
        code: 'API_ERROR',
        status: res.status,
        requestId: headers['x-request-id'] ?? null,
        clientRequestId: res.clientRequestId ?? null,
        retryAfter: headers['retry-after'] ?? null,
        apiCode: details.code ?? null,
        apiType: details.type ?? null,
        param: details.param ?? null,
        retryable: retryableStatus.has(res.status),
    });
}
