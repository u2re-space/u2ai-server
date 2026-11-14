/**
 * @file src/server/mcp.js
 * @module server/mcp
 * @purpose The MCP server of the package: JSON-RPC 2.0 over stdio or over HTTP.
 *
 *   The server speaks the Model Context Protocol without an SDK: the messages are plain
 *   JSON-RPC 2.0 objects, the transport is a stream of lines (stdio) or a POST (HTTP).
 *
 *   The server publishes the tools of the package — the file system, the terminal, the
 *   workspace scan — and answers `initialize`, `tools/list`, `tools/call`, `resources/list`,
 *   `resources/read`, `prompts/list`, `prompts/get` and `ping`.
 *
 *   Three rules keep the server honest:
 *
 *   1. a tool that the configuration forbids is not listed and not called;
 *   2. a call that runs too long is aborted and answered with a timeout;
 *   3. a cancelled call is aborted and stays unanswered, as the protocol asks.
 *
 * @depends node:http, tools/tools, tools/context, shared/format
 * @usedBy cli, server/serve, server/stdio
 * @exports MCP_PROTOCOL_VERSION, MCP_SUPPORTED_PROTOCOLS, MCP_ERROR, MCP_RESOURCES,
 *          MCP_PROMPTS, mcpToolList, createMcpServer, createMcpHttpHandler,
 *          startHttpServer, newMcpToken, errorResponse
 * @ai.tags mcp, jsonrpc, server
 * @ai.hint io
 */

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { TOOL_SPECS, TOOL_NAMES, executeTool, describeTool, toolAllowed } from '../tools/tools.js';
import { scanWorkspace, formatWorkspace } from '../tools/context.js';
import { checkToken, readJsonBody } from './http.js';

/** The version of the protocol the server speaks first. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** The versions of the protocol the server understands. */
export const MCP_SUPPORTED_PROTOCOLS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);

/** The codes of the errors of JSON-RPC and of MCP. */
export const MCP_ERROR = Object.freeze({
    parse: -32700,
    invalidRequest: -32600,
    methodNotFound: -32601,
    invalidParams: -32602,
    internal: -32603,
    timeout: -32001,
    cancelled: -32800,
});

/** The resources the server publishes. */
export const MCP_RESOURCES = Object.freeze([
    Object.freeze({ uri: 'ai-serve://config', name: 'Configuration', description: 'The resolved configuration of the server.', mimeType: 'application/json' }),
    Object.freeze({ uri: 'ai-serve://tools', name: 'Tools', description: 'The catalog of the tools of the server.', mimeType: 'application/json' }),
    Object.freeze({ uri: 'ai-serve://workspace', name: 'Workspace', description: 'The card of the working directory.', mimeType: 'text/plain' }),
]);

/** The prompts the server publishes. */
export const MCP_PROMPTS = Object.freeze([
    Object.freeze({
        name: 'analyze-task',
        description: 'Analyze a task against the project and name the files it touches.',
        arguments: Object.freeze([Object.freeze({ name: 'task', description: 'The task of the user.', required: true })]),
    }),
    Object.freeze({
        name: 'plan-work',
        description: 'Write a plan of the work for a task.',
        arguments: Object.freeze([Object.freeze({ name: 'task', description: 'The task of the user.', required: true })]),
    }),
    Object.freeze({
        name: 'review-code',
        description: 'Review a file and name the problems of it.',
        arguments: Object.freeze([Object.freeze({ name: 'path', description: 'The path of the file.', required: true })]),
    }),
]);

/**
 * The answer of an error of JSON-RPC.
 *
 * The helper lives here, because the transports build their answers with it: the
 * stdio transport of the server (`server/stdio.js`) and the HTTP route of the
 * protocol (`/mcp`).
 *
 * @param {string|number|null} id the id of the message
 * @param {number} code
 * @param {string} message
 * @param {unknown} [data]
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function errorResponse(id, code, message, data) {
    const error = { code, message };
    if (data !== undefined) error.data = data;
    return { jsonrpc: '2.0', id: id ?? null, error };
}

/**
 * The catalog of the tools in the shape of MCP.
 * @param {string[]} [names]
 * @returns {{ name: string, description: string, inputSchema: object }[]}
 * @exports
 * @ai.hint pure
 */
export function mcpToolList(names = TOOL_NAMES) {
    const wanted = Array.isArray(names) && names.length ? names : TOOL_NAMES;
    const out = [];
    for (const name of wanted) {
        const spec = TOOL_SPECS[name];
        if (!spec) continue;
        out.push({
            name,
            description: spec.description,
            inputSchema: spec.parameters,
        });
    }
    return out;
}

/**
 * Create the server of the protocol.
 *
 * @param {{ root?: string, config?: object|null, timeoutMs?: number, callTool?: Function|null,
 *           name?: string, version?: string }} [options]
 * @returns {{ handle: (message: unknown) => Promise<object|object[]|null>,
 *             listTools: () => object[], close: () => void }}
 * @exports
 * @ai.hint io
 */
export function createMcpServer({
    root = process.cwd(),
    config = null,
    timeoutMs = 120_000,
    callTool = null,
    name = 'ai-serve',
    version = '0.3.0',
} = {}) {
    /** The calls that are running now: the id of the request and the abort of it. */
    const pending = new Map();

    const runTool = callTool ?? ((toolName, args, { signal }) => executeTool(toolName, args, { root, config, signal }));

    /**
     * Whether the configuration allows the tool.
     * @param {string} toolName
     * @returns {boolean}
     * @ai.hint pure
     */
    const allowed = (toolName) => toolAllowed(toolName, config);

    /**
     * The tools the server shows: the ones the configuration allows.
     * @returns {{ name: string, description: string, inputSchema: object }[]}
     * @ai.hint pure
     */
    const listTools = () => mcpToolList(TOOL_NAMES.filter((toolName) => allowed(toolName)));

    /**
     * The answer of `resources/read`.
     * @param {string} uri
     * @returns {Promise<object|null>}
     * @ai.hint io
     */
    const readResource = async (uri) => {
        if (uri === 'ai-serve://config') {
            const safe = config ? { ...config } : {};
            return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(safe, null, 2) }] };
        }
        if (uri === 'ai-serve://tools') {
            return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(listTools(), null, 2) }] };
        }
        if (uri === 'ai-serve://workspace') {
            const card = await scanWorkspace(root, {});
            return { contents: [{ uri, mimeType: 'text/plain', text: formatWorkspace(card) }] };
        }
        return null;
    };

    /**
     * The answer of `prompts/get`.
     * @param {string} promptName
     * @param {object} args
     * @returns {object|null}
     * @ai.hint pure
     */
    const readPrompt = (promptName, args) => {
        const prompt = MCP_PROMPTS.find((item) => item.name === promptName);
        if (!prompt) return null;
        const values = args && typeof args === 'object' ? args : {};
        const task = typeof values.task === 'string' ? values.task : '';
        const file = typeof values.path === 'string' ? values.path : '';
        const text = promptName === 'review-code'
            ? `Review the file ${file}. Name the problems of it and the way to fix them.`
            : promptName === 'plan-work'
                ? `Write a plan of the work for the task: ${task}. Name the files of every step.`
                : `Analyze the task against the project: ${task}. Name the files it touches and the risks.`;
        return {
            description: prompt.description,
            messages: [{ role: 'user', content: { type: 'text', text } }],
        };
    };

    /**
     * The answer of `tools/call`.
     * @param {string|number|null} id
     * @param {object} params
     * @returns {Promise<object|null>}
     * @ai.hint io
     */
    const callToolMethod = async (id, params) => {
        const toolName = params?.name;
        if (typeof toolName !== 'string' || !toolName) {
            return errorResponse(id, MCP_ERROR.invalidParams, 'The name of the tool is missing.');
        }
        if (!TOOL_SPECS[toolName]) {
            return errorResponse(id, MCP_ERROR.invalidParams, `There is no tool named ${toolName}.`);
        }
        if (!allowed(toolName)) {
            return errorResponse(id, MCP_ERROR.invalidParams, `The configuration does not allow the tool ${toolName}.`);
        }
        const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
        const controller = new AbortController();
        const entry = { controller, cancelled: false };
        const key = id === null || id === undefined ? null : String(id);
        if (key !== null) pending.set(key, entry);

        let timer = null;
        const timeout = new Promise((resolve) => {
            timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
            timer.unref?.();
        });
        const work = runTool(toolName, args, { signal: controller.signal })
            .then((value) => ({ value }), (error) => ({ error }));

        try {
            const outcome = await Promise.race([work, timeout]);
            if (outcome.timedOut) {
                controller.abort();
                return errorResponse(id, MCP_ERROR.timeout, `The tool ${toolName} did not finish in ${timeoutMs} ms.`);
            }
            // A cancelled call stays unanswered: the protocol asks for it.
            if (entry.cancelled) return null;
            if (outcome.error) {
                return {
                    jsonrpc: '2.0',
                    id,
                    result: {
                        content: [{ type: 'text', text: outcome.error?.message ?? String(outcome.error) }],
                        isError: true,
                    },
                };
            }
            const text = typeof outcome.value?.text === 'string' ? outcome.value.text : JSON.stringify(outcome.value ?? null);
            return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: false } };
        } finally {
            if (timer) clearTimeout(timer);
            if (key !== null) pending.delete(key);
        }
    };

    /**
     * The answer of one message of the protocol.
     * @param {unknown} message
     * @returns {Promise<object|object[]|null>}
     * @ai.hint io
     */
    const handleMessage = async (message) => {
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
            return errorResponse(null, MCP_ERROR.invalidRequest, 'A message must be a JSON object.');
        }
        const { id, method, params } = message;
        if (typeof method !== 'string' || !method) {
            return errorResponse(id ?? null, MCP_ERROR.invalidRequest, 'The method is missing.');
        }

        if (method === 'notifications/cancelled') {
            const key = params?.requestId === undefined || params?.requestId === null ? null : String(params.requestId);
            const entry = key === null ? null : pending.get(key);
            if (entry) {
                entry.cancelled = true;
                entry.controller.abort();
            }
            return null;
        }
        if (method === 'notifications/initialized' || method.startsWith('notifications/')) return null;

        if (method === 'initialize') {
            const wanted = params?.protocolVersion;
            const protocolVersion = MCP_SUPPORTED_PROTOCOLS.includes(wanted) ? wanted : MCP_PROTOCOL_VERSION;
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    protocolVersion,
                    capabilities: {
                        tools: { listChanged: false },
                        resources: { subscribe: false, listChanged: false },
                        prompts: { listChanged: false },
                    },
                    serverInfo: { name, version },
                },
            };
        }
        if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
        if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: listTools() } };
        if (method === 'tools/call') return callToolMethod(id, params);
        if (method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: MCP_RESOURCES.map((item) => ({ ...item })) } };
        if (method === 'resources/read') {
            const uri = params?.uri;
            if (typeof uri !== 'string' || !uri) {
                return errorResponse(id, MCP_ERROR.invalidParams, 'The uri of the resource is missing.');
            }
            const answer = await readResource(uri);
            if (!answer) return errorResponse(id, MCP_ERROR.invalidParams, `There is no resource named ${uri}.`);
            return { jsonrpc: '2.0', id, result: answer };
        }
        if (method === 'prompts/list') {
            return {
                jsonrpc: '2.0',
                id,
                result: { prompts: MCP_PROMPTS.map((item) => ({ ...item, arguments: item.arguments.map((argument) => ({ ...argument })) })) },
            };
        }
        if (method === 'prompts/get') {
            const promptName = params?.name;
            if (typeof promptName !== 'string' || !promptName) {
                return errorResponse(id, MCP_ERROR.invalidParams, 'The name of the prompt is missing.');
            }
            const answer = readPrompt(promptName, params?.arguments);
            if (!answer) return errorResponse(id, MCP_ERROR.invalidParams, `There is no prompt named ${promptName}.`);
            return { jsonrpc: '2.0', id, result: answer };
        }
        return errorResponse(id ?? null, MCP_ERROR.methodNotFound, `There is no method named ${method}.`);
    };

    /**
     * The answer of a message or of a batch of messages.
     * @param {unknown} message
     * @returns {Promise<object|object[]|null>}
     * @ai.hint io
     */
    const handle = async (message) => {
        if (Array.isArray(message)) {
            const answers = [];
            for (const item of message) {
                const answer = await handleMessage(item);
                if (answer) answers.push(answer);
            }
            return answers.length ? answers : null;
        }
        return handleMessage(message);
    };

    return { handle, listTools, close: () => pending.clear() };
}

/**
 * The handler of the HTTP transport: the route `/mcp` takes a JSON-RPC message and
 * answers with the answer of it.
 *
 * The handler returns false for every other route, so the caller may answer in its own way.
 *
 * @param {{ server: object, tokens?: string[], maxBodyBytes?: number }} options
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<boolean>}
 * @exports
 * @ai.hint io
 */
export function createMcpHttpHandler({ server, tokens = [], maxBodyBytes = 8 * 1024 * 1024 } = {}) {
    return async function handle(req, res) {
        let pathname = '/';
        try {
            pathname = new URL(String(req?.url ?? '/'), 'http://127.0.0.1').pathname;
        } catch { /* a broken URL falls back to the root */ }
        if (pathname !== '/mcp') return false;
        const method = String(req?.method ?? 'GET').toUpperCase();

        /**
         * Answer with a JSON body.
         * @param {number} status
         * @param {unknown} payload
         * @returns {void}
         * @ai.hint io
         */
        const respond = (status, payload) => {
            const body = JSON.stringify(payload);
            res.writeHead(status, {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': Buffer.byteLength(body),
                'Cache-Control': 'no-store',
            });
            res.end(body);
        };

        if (method !== 'POST') {
            respond(405, { error: { code: 'method_not_allowed', message: 'POST is the method of /mcp.' } });
            return true;
        }
        if (!checkToken(req, tokens)) {
            respond(401, { error: { code: 'unauthorized', message: 'The token of the server is needed.' } });
            return true;
        }
        const body = await readJsonBody(req, maxBodyBytes);
        if (!body.ok) {
            respond(body.code === 'too_large' ? 413 : 400, { error: { code: body.code, message: body.message } });
            return true;
        }
        try {
            const answer = await server.handle(body.value);
            if (!answer) {
                respond(202, { status: 'accepted' });
                return true;
            }
            respond(200, answer);
        } catch (error) {
            respond(500, { error: { code: 'internal_error', message: error?.message ?? String(error) } });
        }
        return true;
    };
}

/**
 * Run the server over HTTP.
 *
 * `POST /mcp` takes a JSON-RPC message and answers with the answer of it; `GET /health`
 * stays open, because a probe should not need a secret.
 *
 * @param {{ server: object, port?: number, host?: string, token?: string|null }} options
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 * @exports
 * @ai.hint io
 */
export async function startHttpServer({ server, port = 0, host = '127.0.0.1', token = null } = {}) {
    const mcp = createMcpHttpHandler({ server, tokens: token ? [token] : [] });
    const http = createServer(async (req, res) => {
        let pathname = '/';
        try {
            pathname = new URL(String(req?.url ?? '/'), 'http://127.0.0.1').pathname;
        } catch { /* a broken URL falls back to the root */ }
        const method = String(req?.method ?? 'GET').toUpperCase();

        if (pathname === '/health' && method === 'GET') {
            const body = JSON.stringify({ status: 'ok', pid: process.pid });
            res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': Buffer.byteLength(body),
                'Cache-Control': 'no-store',
            });
            res.end(body);
            return;
        }
        if (await mcp(req, res)) return;
        const body = JSON.stringify({ error: { code: 'not_found', message: `There is no route named ${pathname}.` } });
        res.writeHead(404, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(body),
        });
        res.end(body);
    });

    await new Promise((resolve, reject) => {
        http.once('error', reject);
        http.listen(port, host, resolve);
    });
    const info = http.address();
    const realPort = typeof info === 'object' && info ? info.port : port;

    return {
        url: `http://${host}:${realPort}/mcp`,
        port: realPort,
        async close() {
            await new Promise((resolve) => http.close(resolve));
            server.close?.();
        },
    };
}

/**
 * A fresh token of the server.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function newMcpToken() {
    return randomBytes(32).toString('hex');
}

/**
 * The short description of a tool, for the text of the CLI.
 * @param {string} name
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function mcpToolLine(name) {
    const spec = describeTool(name);
    return spec ? `${name} (${spec.category}, ${spec.risk})` : name;
}
