/**
 * @file src/client/fetch.js
 * @module client/fetch
 * @purpose The low-level HTTP transport of the MCP client: one POST, one answer.
 *
 *   The transport uses the global `fetch` of Node — the package has no dependencies — and
 *   sends the JSON-RPC message as the body of the request. The token of the server goes
 *   into the header `Authorization`, when the server wants one.
 *
 * @depends nothing
 * @usedBy client/http
 * @exports createFetchTransport
 * @ai.tags mcp, client, http
 * @ai.hint io
 */

/**
 * Create the transport over HTTP.
 *
 * @param {{ url: string, token?: string|null, headers?: object, timeoutMs?: number,
 *           fetchImpl?: Function }} options
 * @returns {{ send: (message: object) => Promise<object|null>, notify: (message: object) => void, close: () => void }}
 * @exports
 * @ai.hint io
 */
export function createFetchTransport({ url, token = null, headers = {}, timeoutMs = 60_000, fetchImpl = globalThis.fetch } = {}) {
    if (typeof url !== 'string' || !url.trim()) throw new Error('The URL of the MCP server is needed.');
    if (typeof fetchImpl !== 'function') throw new Error('The global fetch of Node is needed.');

    /**
     * The headers of a request.
     * @returns {object}
     * @ai.hint pure
     */
    const requestHeaders = () => {
        const out = { 'Content-Type': 'application/json', Accept: 'application/json', ...headers };
        if (token) out.Authorization = `Bearer ${token}`;
        return out;
    };

    /**
     * Send a request and wait for its answer.
     * @param {object} message
     * @returns {Promise<object|null>}
     * @ai.hint io
     */
    const send = async (message) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        timer.unref?.();
        try {
            const answer = await fetchImpl(url, {
                method: 'POST',
                headers: requestHeaders(),
                body: JSON.stringify(message),
                signal: controller.signal,
            });
            const text = await answer.text();
            if (!answer.ok) {
                let message = `The MCP server answered ${answer.status}.`;
                try {
                    const parsed = JSON.parse(text);
                    if (parsed?.error?.message) message = parsed.error.message;
                } catch { /* the body is not JSON */ }
                throw new Error(message);
            }
            if (!text.trim()) return null;
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) {
                return parsed.find((item) => item?.id === message?.id) ?? parsed[0] ?? null;
            }
            return parsed;
        } finally {
            clearTimeout(timer);
        }
    };

    /**
     * Send a notification. The server answers nothing, so the answer is ignored.
     * @param {object} message
     * @returns {void}
     * @ai.hint io
     */
    const notify = (message) => {
        fetchImpl(url, {
            method: 'POST',
            headers: requestHeaders(),
            body: JSON.stringify(message),
        }).catch(() => { /* the notification is not worth a crash */ });
    };

    return { send, notify, close: () => { } };
}
