/**
 * @file src/server/http.js
 * @module server/http
 * @purpose The HTTP part of the server: the health probe, the tool list and the bridges.
 *
 *   The HTTP part shares the port with the WebSocket bus: an editor that knows one port
 *   knows both. Every route under `/v1` needs the token of the server — the same token
 *   that `serve.json` carries — and `/health` stays open, because a probe should not
 *   need a secret.
 *
 *   The bridges themselves (the completion and the structure of a file) are plugged in by
 *   the caller: this module only knows the routes, the token and the shape of the answers.
 *
 * @depends shared/decoder
 * @usedBy server/serve
 * @exports HTTP_ROUTES, checkToken, readJsonBody, corsHeaders, createHttpHandler
 * @ai.tags http, bridge
 * @ai.hint io
 */

import { validateComplete } from '../shared/decoder.js';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const textOf = (value) => (typeof value === 'string' ? value : '');

/** The routes of the HTTP part. */
export const HTTP_ROUTES = Object.freeze([
    Object.freeze({ method: 'GET', path: '/health', auth: false, name: 'health' }),
    Object.freeze({ method: 'GET', path: '/v1/tools', auth: true, name: 'tools' }),
    Object.freeze({ method: 'GET', path: '/v1/serves', auth: true, name: 'serves' }),
    Object.freeze({ method: 'POST', path: '/v1/complete', auth: true, name: 'complete' }),
    Object.freeze({ method: 'POST', path: '/v1/structure', auth: true, name: 'structure' }),
]);

/**
 * The headers of the CORS.
 *
 * The server listens on 127.0.0.1 and every route under `/v1` needs the token, so the
 * extensions of the editor may read the answers from their own page.
 * @returns {Record<string, string>}
 * @exports
 * @ai.hint pure
 */
export function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-AI-Serve-Token',
        'Access-Control-Max-Age': '600',
    };
}

/**
 * Answer with a JSON body.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 * @returns {void}
 * @ai.hint io
 */
function respondJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

/**
 * The token of the request: the header, the query, or the body of a form.
 * @param {import('node:http').IncomingMessage} req
 * @returns {string|null}
 * @exports
 * @ai.hint pure
 */
export function requestToken(req) {
    const header = req?.headers?.authorization ?? req?.headers?.Authorization;
    if (typeof header === 'string' && header.trim()) {
        const bearer = header.match(/^Bearer\s+(.+)$/i);
        return (bearer ? bearer[1] : header).trim();
    }
    const custom = req?.headers?.['x-ai-serve-token'];
    if (typeof custom === 'string' && custom.trim()) return custom.trim();
    try {
        const url = new URL(String(req?.url ?? '/'), 'http://127.0.0.1');
        const query = url.searchParams.get('token');
        if (query && query.trim()) return query.trim();
    } catch { /* a broken URL has no token */ }
    return null;
}

/**
 * Whether the token of the request is one of the accepted ones.
 * @param {import('node:http').IncomingMessage} req
 * @param {string[]} tokens
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function checkToken(req, tokens = []) {
    const list = (Array.isArray(tokens) ? tokens : [tokens]).filter((item) => typeof item === 'string' && item.trim());
    if (!list.length) return true;
    const given = requestToken(req);
    if (!given) return false;
    return list.includes(given);
}

/**
 * Read the JSON body of a request, with a cap.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [maxBytes]
 * @returns {Promise<{ ok: true, value: object } | { ok: false, code: string, message: string }>}
 * @exports
 * @ai.hint io
 */
export async function readJsonBody(req, maxBytes = 8 * 1024 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBytes) {
            return { ok: false, code: 'too_large', message: `The body is bigger than ${maxBytes} bytes.` };
        }
        chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw.trim()) return { ok: true, value: {} };
    try {
        const parsed = JSON.parse(raw);
        if (!isRecord(parsed)) return { ok: false, code: 'bad_request', message: 'The body must be a JSON object.' };
        return { ok: true, value: parsed };
    } catch (error) {
        return { ok: false, code: 'bad_json', message: `The body is not valid JSON: ${error.message}` };
    }
}

/**
 * The handler of the HTTP part.
 *
 * The handler answers the requests of the routes of `HTTP_ROUTES` and returns `false`
 * for everything else, so that the caller may answer in its own way.
 *
 * @param {{ tokens?: string[], tools?: object[]|Function, serves?: object[]|Function,
 *           onComplete?: Function|null, onStructure?: Function|null, onHealth?: Function|null,
 *           maxBodyBytes?: number }} [options]
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<boolean>}
 * @exports
 * @ai.hint io
 */
export function createHttpHandler({
    tokens = [],
    tools = [],
    serves = [],
    onComplete = null,
    onStructure = null,
    onHealth = null,
    maxBodyBytes = 8 * 1024 * 1024,
} = {}) {
    return async function handle(req, res) {
        for (const [name, value] of Object.entries(corsHeaders())) res.setHeader(name, value);

        let pathname = '/';
        try {
            pathname = new URL(String(req?.url ?? '/'), 'http://127.0.0.1').pathname;
        } catch { /* a broken URL falls back to the root */ }
        const method = String(req?.method ?? 'GET').toUpperCase();

        const route = HTTP_ROUTES.find((item) => item.path === pathname);
        if (!route) return false;

        // The preflight of the browser: the headers are enough, the body is empty.
        if (method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return true;
        }

        if (route.method !== method) {
            respondJson(res, 405, { error: { code: 'method_not_allowed', message: `${route.method} is the method of ${route.path}.` } });
            return true;
        }
        if (route.auth && !checkToken(req, tokens)) {
            respondJson(res, 401, { error: { code: 'unauthorized', message: 'The token of the server is needed.' } });
            return true;
        }

        if (route.name === 'health') {
            const extra = onHealth ? await onHealth() : null;
            respondJson(res, 200, {
                status: 'ok',
                pid: process.pid,
                uptimeMs: Math.round(process.uptime() * 1000),
                ...(isRecord(extra) ? extra : {}),
            });
            return true;
        }

        if (route.name === 'tools') {
            const list = typeof tools === 'function' ? await tools() : tools;
            respondJson(res, 200, { tools: Array.isArray(list) ? list : [] });
            return true;
        }

        if (route.name === 'serves') {
            const list = typeof serves === 'function' ? await serves() : serves;
            respondJson(res, 200, { serves: Array.isArray(list) ? list : [] });
            return true;
        }

        const body = await readJsonBody(req, maxBodyBytes);
        if (!body.ok) {
            respondJson(res, body.code === 'too_large' ? 413 : 400, { error: { code: body.code, message: body.message } });
            return true;
        }

        if (route.name === 'complete') {
            const checked = validateComplete({ type: 'complete', ...body.value });
            if (!checked.ok) {
                respondJson(res, 400, { error: { code: checked.code, message: checked.message } });
                return true;
            }
            if (!onComplete) {
                respondJson(res, 501, { error: { code: 'not_implemented', message: 'The completion bridge is not running yet.' } });
                return true;
            }
            try {
                const answer = await onComplete(checked.frame, req);
                respondJson(res, 200, isRecord(answer) ? answer : { text: textOf(answer) });
            } catch (error) {
                respondJson(res, 500, { error: { code: 'internal_error', message: error?.message ?? 'The completion failed.' } });
            }
            return true;
        }

        if (route.name === 'structure') {
            if (!onStructure) {
                respondJson(res, 501, { error: { code: 'not_implemented', message: 'The structure bridge is not running yet.' } });
                return true;
            }
            try {
                const answer = await onStructure(body.value, req);
                respondJson(res, 200, isRecord(answer) ? answer : { structure: answer ?? null });
            } catch (error) {
                respondJson(res, 500, { error: { code: 'internal_error', message: error?.message ?? 'The structure failed.' } });
            }
            return true;
        }

        return false;
    };
}
