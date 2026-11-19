/**
 * @file src/client/proxy.js
 * @module client/proxy
 * @purpose The external MCP servers as a source of tools: the names, the descriptions, and
 *          the calls.
 *
 *   Every external server has its own tools, and two servers may have a tool with the same
 *   name. The proxy gives every tool a name of its own — `server__tool` — and keeps the
 *   way back to the server that owns it, so the model sees one flat list of tools and the
 *   call goes to the right server.
 *
 *   The list of the servers lives in `~/.ai-serve/mcp.json`: an entry is either
 *   `{ name, url, token }` for a server over HTTP or `{ name, command, args, env, cwd }`
 *   for a server that is started over stdio.
 *
 *   The other kind of external service is another `ai-serve` instance. It may already
 *   run somewhere else — the entry holds its url and its token — or it may be started
 *   from here: the process writes `serve.json`, and the address of the bus and the token
 *   of the server are read from that file. The process is watched: when it dies, the
 *   service is gone.
 *
 * @depends client/mcp, client/stdio, client/http, node:child_process
 * @usedBy agent/roles, server/u2ai, cli
 * @exports normalizeServer, proxyToolName, splitProxyToolName, proxyToolDefinition,
 *          connectServer, connectServers, createToolProxy, normalizeService,
 *          startServiceProcess, connectBus, connectService, listServices, httpUrlOf
 * @ai.tags mcp, client, proxy, services
 * @ai.hint io
 */

import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { createMcpClient } from './mcp.js';
import { startNodeServer } from './stdio.js';
import { createHttpTransport } from './http.js';
import { readServeRecord, pidAlive } from '../server/serve.js';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The entry of a server, in the shape the proxy uses.
 * @param {object} entry
 * @param {number} [index]
 * @returns {{ name: string, transport: 'stdio'|'http', command: string|null, args: string[],
 *             env: object|null, cwd: string|null, url: string|null, token: string|null,
 *             enabled: boolean, timeoutMs: number }}
 * @exports
 * @ai.hint pure
 */
export function normalizeServer(entry, index = 0) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error('An MCP server must be an object.');
    }
    const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : `server${index + 1}`;
    const command = typeof entry.command === 'string' && entry.command.trim() ? entry.command.trim() : null;
    const url = typeof entry.url === 'string' && entry.url.trim() ? entry.url.trim() : null;
    if (!command && !url) throw new Error(`The MCP server ${name} needs a command or a url.`);
    return {
        name,
        transport: command ? 'stdio' : 'http',
        command,
        args: Array.isArray(entry.args) ? entry.args.map((item) => String(item)) : [],
        env: entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env) ? { ...entry.env } : null,
        cwd: typeof entry.cwd === 'string' && entry.cwd.trim() ? entry.cwd.trim() : null,
        url,
        token: typeof entry.token === 'string' && entry.token.trim() ? entry.token.trim() : null,
        enabled: entry.enabled !== false,
        timeoutMs: Number.isSafeInteger(entry.timeoutMs) && entry.timeoutMs > 0 ? entry.timeoutMs : 60_000,
    };
}

/**
 * The name of a tool of an external server.
 * @param {string} server
 * @param {string} tool
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function proxyToolName(server, tool) {
    return `${server}__${tool}`;
}

/**
 * The server and the tool of a proxy name.
 * @param {string} name
 * @returns {{ server: string, tool: string }|null}
 * @exports
 * @ai.hint pure
 */
export function splitProxyToolName(name) {
    const text = String(name ?? '');
    const index = text.indexOf('__');
    if (index <= 0 || index + 2 >= text.length) return null;
    return { server: text.slice(0, index), tool: text.slice(index + 2) };
}

/**
 * The description of a tool of an external server, in the shape the model reads.
 * @param {string} server
 * @param {{ name: string, description?: string, inputSchema?: object }} tool
 * @returns {{ name: string, description: string, parameters: object, server: string, tool: string }}
 * @exports
 * @ai.hint pure
 */
export function proxyToolDefinition(server, tool) {
    const parameters = tool?.inputSchema ?? tool?.parameters ?? { type: 'object', properties: {}, required: [], additionalProperties: false };
    return {
        name: proxyToolName(server, tool.name),
        description: tool.description ?? `The tool ${tool.name} of the server ${server}.`,
        parameters,
        server,
        tool: tool.name,
    };
}

/**
 * Connect to one external server and read its tools.
 * @param {object} entry the entry of `mcp.json`
 * @param {{ index?: number, protocolVersion?: string, env?: object|null }} [options]
 * @returns {Promise<{ name: string, client: object, tools: object[], close: () => Promise<void> }>}
 * @exports
 * @ai.hint io
 */
export async function connectServer(entry, { index = 0, protocolVersion = undefined, env = null } = {}) {
    const server = normalizeServer(entry, index);
    let transport;
    let closeProcess = async () => { };
    if (server.transport === 'stdio') {
        const child = await startNodeServer({
            command: server.command,
            args: server.args,
            env: server.env ? { ...process.env, ...server.env } : env,
            cwd: server.cwd,
            timeoutMs: server.timeoutMs,
        });
        transport = child.transport;
        closeProcess = () => child.close();
    } else {
        transport = createHttpTransport({ url: server.url, token: server.token, timeoutMs: server.timeoutMs });
    }
    const client = createMcpClient({ transport, ...(protocolVersion ? { protocolVersion } : {}) });
    try {
        await client.initialize();
        const tools = await client.listTools();
        return {
            name: server.name,
            client,
            tools,
            async close() {
                client.close();
                await closeProcess();
            },
        };
    } catch (error) {
        client.close();
        await closeProcess();
        throw error;
    }
}

/**
 * Connect to every enabled server and collect the tools of them.
 *
 * A server that does not come up does not stop the others: the answer says which servers
 * failed and why.
 * @param {object[]} entries the list of `mcp.json`
 * @param {{ protocolVersion?: string, env?: object|null }} [options]
 * @returns {Promise<{ servers: object[], tools: object[], errors: { name: string, message: string }[] }>}
 * @exports
 * @ai.hint io
 */
export async function connectServers(entries, { protocolVersion = undefined, env = null } = {}) {
    const list = Array.isArray(entries) ? entries : [];
    const servers = [];
    const errors = [];
    const tools = [];
    for (const [index, entry] of list.entries()) {
        let server;
        try {
            server = await connectServer(entry, { index, protocolVersion, env });
        } catch (error) {
            const name = entry && typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : `server${index + 1}`;
            errors.push({ name, message: error?.message ?? String(error) });
            continue;
        }
        servers.push(server);
        for (const tool of server.tools) tools.push(proxyToolDefinition(server.name, tool));
    }
    return {
        servers,
        tools,
        errors,
        async close() {
            for (const server of servers) await server.close();
        },
    };
}

/**
 * The text of the answer of an MCP tool.
 * @param {object} answer
 * @returns {string}
 * @ai.hint pure
 */
function toolResultText(answer) {
    const content = Array.isArray(answer?.content) ? answer.content : [];
    const parts = content.map((item) => (typeof item?.text === 'string' ? item.text : '')).filter(Boolean);
    if (parts.length) return parts.join('\n');
    if (typeof answer?.text === 'string') return answer.text;
    return JSON.stringify(answer ?? null);
}

/**
 * Connect to the external MCP servers and make their tools callable.
 *
 * The proxy is the bridge between the flat list of tools and the servers that own them:
 * the model calls `server__tool`, and the call goes to the server that has the tool.
 * A server that does not come up does not stop the others.
 *
 * @param {object[]} entries the list of `mcp.json`
 * @param {{ protocolVersion?: string, env?: object|null }} [options]
 * @returns {Promise<{ tools: object[], errors: object[], servers: object[],
 *           has: (name: string) => boolean,
 *           call: (name: string, args?: object) => Promise<{ ok: boolean, text: string, error: string|null }>,
 *           close: () => Promise<void> }>}
 * @exports
 * @ai.hint io
 */
export async function createToolProxy(entries, { protocolVersion = undefined, env = null } = {}) {
    const connected = await connectServers(entries, { protocolVersion, env });
    const owners = new Map();
    for (const server of connected.servers) {
        for (const tool of server.tools) {
            owners.set(proxyToolName(server.name, tool.name), { server, tool: tool.name });
        }
    }
    return {
        tools: connected.tools,
        errors: connected.errors,
        servers: connected.servers,
        has(name) {
            return owners.has(String(name));
        },
        async call(name, args = {}) {
            const owner = owners.get(String(name));
            if (!owner) {
                const message = `There is no external tool named ${name}.`;
                return { ok: false, text: message, error: message };
            }
            try {
                const answer = await owner.server.client.callTool(owner.tool, args ?? {});
                const text = toolResultText(answer);
                const failed = answer?.isError === true;
                return { ok: !failed, text, error: failed ? text : null };
            } catch (error) {
                const message = error?.message ?? String(error);
                return { ok: false, text: message, error: message };
            }
        },
        close: connected.close,
    };
}

/**
 * Wait for a while.
 * @param {number} ms
 * @returns {Promise<void>}
 * @ai.hint pure
 */
function delay(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Wait for the end of a process, but not longer than the limit.
 * @param {Promise<unknown>} exited
 * @param {number} ms
 * @returns {Promise<void>}
 * @ai.hint pure
 */
async function waitForExit(exited, ms) {
    await new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        exited.then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); resolve(); });
    });
}

/**
 * The entry of an external `ai-serve`, in the shape the client uses.
 *
 * An entry with a `command` is started by us; an entry with a `url` is already running
 * somewhere else. The `file` field points at the `serve.json` of that service.
 *
 * @param {object} entry
 * @param {number} [index]
 * @returns {{ name: string, url: string|null, command: string|null, args: string[],
 *             env: object|null, cwd: string|null, token: string|null, file: string|null,
 *             enabled: boolean, timeoutMs: number }}
 * @exports
 * @ai.hint pure
 */
export function normalizeService(entry, index = 0) {
    if (!isRecord(entry)) throw new Error('A service must be an object.');
    const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : `service${index + 1}`;
    const command = typeof entry.command === 'string' && entry.command.trim() ? entry.command.trim() : null;
    const url = typeof entry.url === 'string' && entry.url.trim() ? entry.url.trim() : null;
    const file = typeof entry.file === 'string' && entry.file.trim() ? entry.file.trim() : null;
    if (!command && !url && !file) throw new Error(`The service ${name} needs a command, a url or a file.`);
    return {
        name,
        url,
        command,
        args: Array.isArray(entry.args) ? entry.args.map((item) => String(item)) : [],
        env: isRecord(entry.env) ? { ...entry.env } : null,
        cwd: typeof entry.cwd === 'string' && entry.cwd.trim() ? entry.cwd.trim() : null,
        token: typeof entry.token === 'string' && entry.token.trim() ? entry.token.trim() : null,
        file,
        enabled: entry.enabled !== false,
        timeoutMs: Number.isSafeInteger(entry.timeoutMs) && entry.timeoutMs > 0 ? entry.timeoutMs : 30_000,
    };
}

/**
 * The http address of a service: the address of the bus becomes an http one.
 * @param {string} url
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function httpUrlOf(url) {
    const text = String(url ?? '').trim();
    if (!text) return '';
    if (text.startsWith('ws://')) return `http://${text.slice(5)}`;
    if (text.startsWith('wss://')) return `https://${text.slice(6)}`;
    return text.replace(/\/$/, '');
}

/**
 * Start an external `ai-serve` and wait for the file with its address.
 *
 * The process prints the path of the file in the line `File: …`; the file itself holds
 * the url of the bus, the token and the pid. A process that dies before the file is
 * there is a failure with the last lines of its error output.
 *
 * @param {{ command: string, args?: string[], env?: object|null, cwd?: string|null,
 *           timeoutMs?: number, onStderr?: Function|null }} options
 * @returns {Promise<{ pid: number, record: object, file: string|null, url: string,
 *           httpURL: string|null, token: string|null, process: object, exited: Promise<object>,
 *           close: () => Promise<void> }>}
 * @exports
 * @ai.hint io
 */
export async function startServiceProcess({
    command,
    args = [],
    env = null,
    cwd = null,
    timeoutMs = 30_000,
    onStderr = null,
} = {}) {
    if (typeof command !== 'string' || !command.trim()) {
        throw new Error('The command of the service is needed.');
    }
    const child = spawn(command, Array.isArray(args) ? args.map(String) : [], {
        cwd: cwd ?? undefined,
        env: { ...process.env, ...(env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });

    let buffer = '';
    let errors = '';
    let file = null;
    let busUrl = null;
    let httpUrl = null;
    let stopInfo = null;

    child.stdout.setEncoding?.('utf8');
    child.stdout.on('data', (chunk) => {
        buffer += String(chunk);
        for (;;) {
            const index = buffer.indexOf('\n');
            if (index < 0) break;
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (!line) continue;
            const fileLine = line.match(/^File:\s*(.+)$/i);
            if (fileLine) {
                file = fileLine[1].trim();
                continue;
            }
            const busLine = line.match(/^Bus:\s*(.+)$/i);
            if (busLine) {
                busUrl = busLine[1].trim();
                continue;
            }
            const httpLine = line.match(/^HTTP:\s*(.+)$/i);
            if (httpLine) httpUrl = httpLine[1].trim();
        }
    });
    child.stderr.setEncoding?.('utf8');
    child.stderr.on('data', (chunk) => {
        errors = `${errors}${String(chunk)}`.slice(-8192);
        onStderr?.(String(chunk));
    });

    const exited = new Promise((resolve) => {
        child.once('error', (error) => resolve({ error }));
        child.once('close', (code, signal) => resolve({ code, signal }));
    });
    exited.then((value) => { stopInfo = value; });

    /**
     * The address of the service, as it is written on the disk.
     * @returns {Promise<object|null>}
     * @ai.hint io
     */
    const readRecord = async () => {
        if (!file) return null;
        try {
            const parsed = JSON.parse(await readFile(file, 'utf8'));
            return isRecord(parsed) ? parsed : null;
        } catch {
            return null;
        }
    };

    const deadline = Date.now() + timeoutMs;
    let record = null;
    while (Date.now() < deadline) {
        record = await readRecord();
        if (record?.url) break;
        if (stopInfo) break;
        await delay(50);
    }

    if (!record?.url) {
        child.kill();
        await waitForExit(exited, 2000);
        const tail = errors.trim().split('\n').filter(Boolean).slice(-3).join(' | ');
        if (stopInfo?.error) throw stopInfo.error;
        const why = stopInfo
            ? `it stopped (code ${stopInfo.code})`
            : `it did not write its address in ${timeoutMs} ms`;
        throw new Error(`The service ${why}${tail ? `: ${tail}` : '.'}`);
    }

    return {
        pid: child.pid,
        record,
        file,
        url: record.url ?? busUrl,
        httpURL: record.httpURL ?? httpUrl,
        token: typeof record.token === 'string' ? record.token : null,
        process: child,
        exited,
        async close() {
            if (child.exitCode == null && child.signalCode == null) child.kill();
            await waitForExit(exited, 3000);
            if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
            // The file of the address is ours when it names our own process. The service may
            // be the worker of the shell we started: wait for it to go, and take the file
            // away when it is gone.
            if (file) {
                let current = await readRecord();
                if (current && current.pid !== child.pid) {
                    for (let attempt = 0; attempt < 40 && pidAlive(current.pid); attempt += 1) {
                        await delay(50);
                    }
                    current = await readRecord();
                }
                if (!current || current.pid === child.pid || !pidAlive(current.pid)) {
                    await rm(file, { force: true });
                }
            }
        },
    };
}

/**
 * Say hello to the bus of another server and wait for the answer.
 *
 * The handshake is the one of the protocol: `hello` with the token, then `ready` with
 * the runs that are already going.
 *
 * @param {{ url: string, token: string, role?: string, timeoutMs?: number }} options
 * @returns {Promise<{ socket: object, ready: object, frames: object[], close: () => void }>}
 * @exports
 * @ai.hint io
 */
export async function connectBus({ url, token, role = 'client', timeoutMs = 10_000 } = {}) {
    if (typeof url !== 'string' || !url.trim()) throw new Error('The url of the bus is needed.');
    if (typeof token !== 'string' || !token.trim()) throw new Error('The token of the bus is needed.');

    const socket = new WebSocket(url);
    const frames = [];
    const waiting = [];
    let closed = false;

    socket.addEventListener('message', (event) => {
        let frame = null;
        try {
            frame = JSON.parse(String(event.data));
        } catch {
            return;
        }
        frames.push(frame);
        const next = waiting.shift();
        if (next) next(frame);
    });
    socket.addEventListener('close', () => {
        closed = true;
        while (waiting.length) waiting.shift()(null);
    });

    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`The bus ${url} did not answer in ${timeoutMs} ms.`)), timeoutMs);
        socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
        socket.addEventListener('error', () => {
            clearTimeout(timer);
            reject(new Error(`The bus ${url} is not reachable.`));
        }, { once: true });
    });

    try {
        socket.send(JSON.stringify({ type: 'hello', role, token }));
    } catch (error) {
        throw new Error(`The bus ${url} closed the connection: ${error?.message ?? error}`);
    }

    const ready = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`The bus ${url} did not say ready in time.`)), timeoutMs);
        waiting.push((frame) => { clearTimeout(timer); resolve(frame); });
        if (closed) {
            clearTimeout(timer);
            resolve(null);
        }
    });
    if (!ready) throw new Error(`The bus ${url} closed the connection.`);
    if (ready.type === 'error') throw new Error(ready.message ?? 'The bus refused the connection.');
    if (ready.type !== 'ready') throw new Error('The bus did not answer with ready.');

    return {
        socket,
        ready,
        frames,
        close() {
            try { socket.close(); } catch { /* the socket is gone */ }
        },
    };
}

/**
 * Connect to an external `ai-serve`.
 *
 * A service with a command is started first; the address and the token come from the
 * file it writes. A service with a url is already running: its token comes from the
 * entry or from the file the entry names.
 *
 * @param {object} entry
 * @param {{ index?: number, timeoutMs?: number }} [options]
 * @returns {Promise<{ name: string, url: string, httpURL: string|null, token: string|null,
 *           record: object|null, bus: object, close: () => Promise<void> }>}
 * @exports
 * @ai.hint io
 */
export async function connectService(entry, { index = 0, timeoutMs = 30_000 } = {}) {
    const service = normalizeService(entry, index);
    let started = null;
    let record = null;
    if (service.command) {
        started = await startServiceProcess({
            command: service.command,
            args: service.args,
            env: service.env,
            cwd: service.cwd,
            timeoutMs: service.timeoutMs || timeoutMs,
        });
        record = started.record;
    } else if (service.file) {
        record = await readServeRecord(service.file);
    }
    const url = record?.url ?? service.url;
    const token = record?.token ?? service.token;
    if (!url) throw new Error(`The service ${service.name} has no address.`);
    const bus = await connectBus({ url, token, timeoutMs });
    return {
        name: service.name,
        url,
        httpURL: record?.httpURL ?? httpUrlOf(url),
        token: token ?? null,
        record,
        bus,
        async close() {
            bus.close();
            if (started) await started.close();
        },
    };
}

/**
 * Whether a service answers on its health route.
 * @param {string} httpURL
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 * @ai.hint io
 */
async function probeHealth(httpURL, timeoutMs) {
    if (!httpURL) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const answer = await fetch(`${httpURL}/health`, { signal: controller.signal });
        return answer.ok;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * The state of the external services.
 *
 * A service with a file is read from that file: the pid says whether the process is
 * alive. A service with a url is asked on its health route.
 *
 * @param {object[]} entries
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<object[]>}
 * @exports
 * @ai.hint io
 */
export async function listServices(entries, { timeoutMs = 5_000 } = {}) {
    const list = Array.isArray(entries) ? entries : [];
    const out = [];
    for (const [index, entry] of list.entries()) {
        let service;
        try {
            service = normalizeService(entry, index);
        } catch (error) {
            out.push({
                name: `service${index + 1}`,
                status: 'error',
                error: error?.message ?? String(error),
                url: null,
                httpURL: null,
                token: null,
                pid: null,
            });
            continue;
        }
        if (!service.enabled) {
            out.push({ name: service.name, status: 'disabled', url: service.url, httpURL: null, token: service.token, pid: null });
            continue;
        }
        const record = service.file ? await readServeRecord(service.file) : null;
        if (record) {
            out.push({
                name: service.name,
                status: pidAlive(record.pid) ? 'running' : 'stopped',
                url: record.url ?? service.url,
                httpURL: record.httpURL ?? null,
                token: typeof record.token === 'string' ? record.token : service.token,
                pid: record.pid ?? null,
            });
            continue;
        }
        if (service.file) {
            // The file is gone: the service is not running any more.
            out.push({ name: service.name, status: 'stopped', url: service.url, httpURL: null, token: service.token, pid: null });
            continue;
        }
        if (!service.url) {
            out.push({ name: service.name, status: 'configured', url: null, httpURL: null, token: service.token, pid: null });
            continue;
        }
        const alive = await probeHealth(httpUrlOf(service.url), timeoutMs);
        out.push({
            name: service.name,
            status: alive ? 'running' : 'stopped',
            url: service.url,
            httpURL: httpUrlOf(service.url),
            token: service.token,
            pid: null,
        });
    }
    return out;
}
