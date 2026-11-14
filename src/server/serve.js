/**
 * @file src/server/serve.js
 * @module server/serve
 * @purpose The lifetime of the server: the port, the token, and the `serve.json` file.
 *
 *   The file `~/.ai-serve/serve.json` is the address of the running server: the pid, the
 *   URL of the bus and the token. A client reads it, checks the pid, and connects. The
 *   file is written with the mode 0600 — the token is a secret — and it is removed when
 *   the server stops.
 *
 *   Two servers never share one home: a file that holds a live pid means that the server
 *   is already running, and the second start is refused.
 *
 * @depends node:fs/promises, node:path, node:crypto, config/paths, server/ws, server/http, shared/protocol
 * @usedBy cli
 * @exports pidAlive, readServeRecord, writeServeRecord, startServe, SERVE_FILE_MODE
 * @ai.tags server, serve
 * @ai.hint io
 */

import { mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { serveFile } from '../config/paths.js';
import { listenWebSocket } from './ws.js';
import { createHttpHandler, checkToken } from './http.js';
import { createMcpHttpHandler } from './mcp.js';
import { attachConnection, attachCompletionSocket } from './u2ai.js';
import { PROTOCOL_VERSION, MAX_FRAME_BYTES } from '../shared/protocol.js';
import { encodeFrame, errorFrame } from '../shared/encoder.js';

/** The mode of the file with the token: only the owner may read it. */
export const SERVE_FILE_MODE = 0o600;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Whether the process with this pid is alive.
 * @param {number} pid
 * @returns {boolean}
 * @exports
 * @ai.hint io
 */
export function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // A process of another user is alive, but we may not signal it.
        return error?.code === 'EPERM';
    }
}

/**
 * Read the file with the address of the server.
 * @param {string} file
 * @returns {Promise<object|null>}
 * @exports
 * @ai.hint io
 */
export async function readServeRecord(file) {
    try {
        const parsed = JSON.parse(await readFile(file, 'utf8'));
        return isRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Write the file with the address of the server.
 * @param {string} file
 * @param {object} record
 * @returns {Promise<void>}
 * @exports
 * @ai.hint io
 */
export async function writeServeRecord(file, record) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, { mode: SERVE_FILE_MODE });
    try {
        await chmod(file, SERVE_FILE_MODE);
    } catch {
        // Windows has no modes; the file is still written.
    }
}

/**
 * The connection handler of a server without a bus.
 *
 * The bus arrives with the next step of the plan; until then the socket is told plainly
 * that there is nothing to talk to.
 * @param {import('./ws.js').WsConnection} connection
 * @returns {void}
 * @ai.hint io
 */
function notReadyConnection(connection) {
    connection.on('message', () => {
        connection.send(JSON.stringify({
            type: 'error',
            code: 'not_ready',
            message: 'The bus of the server is not running yet.',
        }));
        connection.close(1011);
    });
}

/**
 * The path of the request: the part before the query.
 * @param {import('node:http').IncomingMessage} req
 * @returns {string}
 * @ai.hint pure
 */
function requestPath(req) {
    try {
        return new URL(String(req?.url ?? '/'), 'http://127.0.0.1').pathname;
    } catch {
        return '/';
    }
}

/**
 * The connection handler of the server.
 *
 * The socket of the path `/v1/complete` is the bridge of the completion: it does not join
 * the bus and it needs the token of the server in the query. Every other socket is a
 * client of the bus.
 *
 * @param {{ hub: object|null, onComplete: Function|null, tokens: string[] }} options
 * @returns {(connection: object, head: Buffer|null, req: object) => void}
 * @ai.hint pure
 */
function connectionHandler({ hub, onComplete, tokens }) {
    return (connection, head, req) => {
        if (requestPath(req) === '/v1/complete') {
            if (!checkToken(req, tokens)) {
                try {
                    connection.send(encodeFrame(errorFrame('unauthorized', 'The token of the server is needed.')));
                } catch { /* the socket is gone */ }
                connection.close(1008);
                return;
            }
            attachCompletionSocket(connection, { onComplete });
            return;
        }
        if (hub) {
            attachConnection(hub, connection);
            return;
        }
        notReadyConnection(connection);
    };
}

/**
 * Start the server: the bus, the HTTP part and the file with the address.
 *
 * @param {{ home: string, config?: object|null, port?: number, host?: string, token?: string,
 *           onConnection?: Function|null, hub?: object|null, onRequest?: Function|null,
 *           onUpgrade?: Function|null, onComplete?: Function|null, onStructure?: Function|null,
 *           tools?: object[]|Function, mcp?: object|null, writeFile?: boolean, file?: string|null }} [options]
 * @returns {Promise<{ url: string, httpURL: string, port: number, token: string, file: string|null,
 *           record: object, close: () => Promise<void> }>}
 * @exports
 * @ai.hint io
 */
export async function startServe({
    home,
    config = null,
    port = 0,
    host = '127.0.0.1',
    token = randomBytes(32).toString('hex'),
    onConnection = null,
    hub = null,
    onRequest = null,
    onUpgrade = null,
    onComplete = null,
    onStructure = null,
    tools = [],
    mcp = null,
    writeFile: write = true,
    file = null,
} = {}) {
    const target = file ?? (home ? serveFile(home) : null);

    if (target) {
        const existing = await readServeRecord(target);
        if (existing && pidAlive(existing.pid)) {
            const error = new Error(`The server is already running (pid ${existing.pid}).`);
            error.code = 'ALREADY_RUNNING';
            error.pid = existing.pid;
            throw error;
        }
    }

    const tokens = [token, ...(Array.isArray(config?.completion?.tokens) ? config.completion.tokens : [])];
    const http = onRequest ?? createHttpHandler({
        tokens,
        tools,
        onComplete,
        onStructure,
        maxBodyBytes: config?.limits?.maxBodyBytes ?? 8 * 1024 * 1024,
    });
    // The MCP endpoint shares the port and the token of the bus.
    const mcpHandler = mcp ? createMcpHttpHandler({ server: mcp, tokens }) : null;
    const handler = mcpHandler
        ? async (req, res) => (await mcpHandler(req, res)) || await http(req, res)
        : http;

    let listener;
    try {
        listener = await listenWebSocket({
            port,
            host,
            onConnection: onConnection ?? connectionHandler({ hub, onComplete, tokens }),
            onRequest: handler,
            onUpgrade,
            pingIntervalMs: config?.server?.pingIntervalMs ?? 30_000,
            idleMs: config?.server?.idleTimeoutMs ?? 90_000,
            maxFrameBytes: config?.limits?.maxFrameBytes ?? MAX_FRAME_BYTES,
        });
    } catch (error) {
        if (error?.code === 'EADDRINUSE') {
            const busy = new Error(`The port ${port} is busy.`);
            busy.code = 'PORT_BUSY';
            busy.port = port;
            throw busy;
        }
        throw error;
    }

    const record = {
        pid: process.pid,
        url: listener.url,
        httpURL: listener.httpURL,
        token,
        protocol: PROTOCOL_VERSION,
        startedAt: new Date().toISOString(),
    };
    if (target && write) await writeServeRecord(target, record);

    let closed = false;
    /**
     * Stop the server and remove the file with its address.
     * @returns {Promise<void>}
     * @ai.hint io
     */
    const close = async () => {
        if (closed) return;
        closed = true;
        await listener.close();
        if (target && write) {
            const current = await readServeRecord(target);
            // Only our own file is removed: another server may have taken the home.
            if (!current || current.pid === process.pid) await rm(target, { force: true });
        }
    };

    return {
        url: listener.url,
        httpURL: listener.httpURL,
        port: listener.port,
        token,
        file: target,
        record,
        close,
    };
}
