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
 * @depends client/mcp, client/node, client/http
 * @usedBy agent/roles, server/u2ai
 * @exports normalizeServer, proxyToolName, splitProxyToolName, proxyToolDefinition,
 *          connectServer, connectServers
 * @ai.tags mcp, client, proxy
 * @ai.hint io
 */

import { createMcpClient } from './mcp.js';
import { startNodeServer } from './node.js';
import { createHttpTransport } from './http.js';

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
