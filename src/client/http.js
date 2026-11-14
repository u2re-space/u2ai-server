/**
 * @file src/client/http.js
 * @module client/http
 * @purpose The HTTP transport of the MCP client: the URL of the server and its token.
 *
 *   The URL of the MCP endpoint of a running `ai-serve` comes from the file `serve.json`:
 *   the address and the token live there. This module turns that record into a transport.
 *
 * @depends client/fetch
 * @usedBy client/proxy
 * @exports mcpUrl, createHttpTransport
 * @ai.tags mcp, client, http
 * @ai.hint io
 */

import { createFetchTransport } from './fetch.js';

/**
 * The URL of the MCP endpoint of a server.
 * @param {{ httpURL?: string, url?: string, port?: number }} record the record of `serve.json`
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function mcpUrl(record) {
    if (!record) throw new Error('The record of the server is needed.');
    const base = typeof record.httpURL === 'string' && record.httpURL.trim()
        ? record.httpURL.trim()
        : typeof record.url === 'string' && record.url.trim()
            ? record.url.trim().replace(/^ws/, 'http')
            : null;
    if (!base) throw new Error('The record of the server has no address.');
    return `${base.replace(/\/$/, '')}/mcp`;
}

/**
 * Create the transport over HTTP.
 *
 * @param {{ url?: string, baseURL?: string|null, record?: object|null, token?: string|null,
 *           headers?: object, timeoutMs?: number }} options
 * @returns {{ send: Function, notify: Function, close: Function }}
 * @exports
 * @ai.hint io
 */
export function createHttpTransport({ url = null, baseURL = null, record = null, token = null, headers = {}, timeoutMs = 60_000 } = {}) {
    const target = url ?? (record ? mcpUrl(record) : baseURL ? `${String(baseURL).replace(/\/$/, '')}/mcp` : null);
    if (!target) throw new Error('The URL of the MCP server is needed.');
    const key = token ?? (record && typeof record.token === 'string' ? record.token : null);
    return createFetchTransport({ url: target, token: key, headers, timeoutMs });
}
