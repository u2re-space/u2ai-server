/**
 * @file src/client/mcp.js
 * @module client/mcp
 * @purpose The client of the Model Context Protocol: the requests, the handshake, and the
 *          answers of the server.
 *
 *   The client speaks the same JSON-RPC 2.0 as the server of the package, but it is the
 *   one who asks: it sends the request, waits for the answer of the id, and turns an
 *   error of the protocol into an exception with the code of the protocol.
 *
 *   The transport is a small interface — `send`, `notify`, `close` — so that the same
 *   client works over stdio and over HTTP.
 *
 * @depends nothing
 * @usedBy client/stdio, client/http, client/proxy
 * @exports CLIENT_PROTOCOL_VERSIONS, McpError, createMcpClient, toolText
 * @ai.tags mcp, client, jsonrpc
 * @ai.hint io
 */

/** The versions of the protocol the client speaks, newest first. */
export const CLIENT_PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);

/**
 * An error of the protocol: the code of the server and its data.
 */
export class McpError extends Error {
    /**
     * @param {number|string} code
     * @param {string} message
     * @param {unknown} [data]
     */
    constructor(code, message, data) {
        super(message);
        this.name = 'McpError';
        this.code = code;
        this.data = data;
    }
}

/**
 * The text of the answer of a tool.
 * @param {object} result
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function toolText(result) {
    const content = Array.isArray(result?.content) ? result.content : [];
    return content
        .filter((item) => item && item.type === 'text' && typeof item.text === 'string')
        .map((item) => item.text)
        .join('\n');
}

/**
 * Create the client of the protocol.
 *
 * @param {{ transport: { send: Function, notify?: Function, close?: Function },
 *           protocolVersion?: string, timeoutMs?: number, name?: string, version?: string }} options
 * @returns {{ initialize: () => Promise<object>, listTools: () => Promise<object[]>,
 *             callTool: (name: string, args?: object) => Promise<object>,
 *             listResources: () => Promise<object[]>, readResource: (uri: string) => Promise<object>,
 *             listPrompts: () => Promise<object[]>, getPrompt: (name: string, args?: object) => Promise<object>,
 *             request: (method: string, params?: object) => Promise<object>, close: () => void }}
 * @exports
 * @ai.hint io
 */
export function createMcpClient({
    transport,
    protocolVersion = CLIENT_PROTOCOL_VERSIONS[0],
    name = 'ai-serve',
    version = '0.3.0',
} = {}) {
    if (!transport || typeof transport.send !== 'function') {
        throw new Error('The client needs a transport with a send method.');
    }
    let nextId = 0;
    let handshake = null;

    /**
     * One request and its answer.
     * @param {string} method
     * @param {object} [params]
     * @returns {Promise<object>}
     * @ai.hint io
     */
    const request = async (method, params) => {
        nextId += 1;
        const id = nextId;
        const answer = await transport.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
        if (!answer) throw new McpError('no_answer', `The server did not answer ${method}.`);
        if (answer.error) {
            throw new McpError(answer.error.code ?? 'unknown', answer.error.message ?? 'The server refused the request.', answer.error.data);
        }
        return answer.result ?? {};
    };

    /**
     * A notification: the server does not answer it.
     * @param {string} method
     * @param {object} [params]
     * @returns {void}
     * @ai.hint io
     */
    const notify = (method, params) => {
        transport.notify?.({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
    };

    /**
     * The handshake of the protocol.
     * @returns {Promise<object>}
     * @ai.hint io
     */
    const initialize = async () => {
        const result = await request('initialize', {
            protocolVersion,
            capabilities: {},
            clientInfo: { name, version },
        });
        notify('notifications/initialized');
        handshake = result;
        return result;
    };

    return {
        initialize,
        /** The version the server and the client agreed on. */
        get handshake() { return handshake; },
        /** The tools of the server. */
        listTools: async () => {
            const result = await request('tools/list');
            return Array.isArray(result?.tools) ? result.tools : [];
        },
        /** One call of a tool. */
        callTool: async (toolName, args = {}) => request('tools/call', { name: toolName, arguments: args ?? {} }),
        /** The resources of the server. */
        listResources: async () => {
            const result = await request('resources/list');
            return Array.isArray(result?.resources) ? result.resources : [];
        },
        /** One resource of the server. */
        readResource: async (uri) => request('resources/read', { uri }),
        /** The prompts of the server. */
        listPrompts: async () => {
            const result = await request('prompts/list');
            return Array.isArray(result?.prompts) ? result.prompts : [];
        },
        /** One prompt of the server. */
        getPrompt: async (promptName, args = {}) => request('prompts/get', { name: promptName, arguments: args ?? {} }),
        request,
        close: () => transport.close?.(),
    };
}
