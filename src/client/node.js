/**
 * @file src/client/node.js
 * @module client/node
 * @purpose The stdio transport of the MCP client: start the server as a child process and
 *          speak the protocol over its standard input and output.
 *
 *   The child gets the environment of the package: every variable that looks like a
 *   secret is gone, so a third-party server never sees the keys of the user.
 *
 *   The answers come back line by line: one JSON message per line. A request that gets
 *   no answer in time is refused, and the child that dies takes the waiting requests with
 *   it.
 *
 * @depends node:child_process
 * @usedBy client/proxy
 * @exports startNodeServer
 * @ai.tags mcp, client, stdio
 * @ai.hint io
 */

import { spawn } from 'node:child_process';
import { childEnvironment } from '../tools/terminal.js';

/**
 * Start an MCP server as a child process and speak the protocol with it.
 *
 * @param {{ command: string, args?: string[], env?: object|null, cwd?: string|null,
 *           timeoutMs?: number, onStderr?: Function|null }} options
 * @returns {Promise<{ transport: object, process: object, stderr: () => string, close: () => Promise<void> }>}
 * @exports
 * @ai.hint io
 */
export async function startNodeServer({
    command,
    args = [],
    env = null,
    cwd = null,
    timeoutMs = 60_000,
    onStderr = null,
} = {}) {
    if (typeof command !== 'string' || !command.trim()) {
        throw new Error('The command of the MCP server is needed.');
    }
    const child = spawn(command, Array.isArray(args) ? args.map(String) : [], {
        cwd: cwd ?? undefined,
        env: childEnvironment(env ?? process.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
    });

    const pending = new Map();
    let buffer = '';
    let errors = '';
    let closed = false;

    /**
     * Refuse every waiting request.
     * @param {Error} error
     * @returns {void}
     * @ai.hint io
     */
    const failAll = (error) => {
        for (const entry of pending.values()) {
            clearTimeout(entry.timer);
            entry.reject(error);
        }
        pending.clear();
    };

    /**
     * The answer of one line of the output.
     * @param {string} line
     * @returns {void}
     * @ai.hint pure
     */
    const handleLine = (line) => {
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            return;
        }
        const id = message?.id;
        if (id === undefined || id === null) return;
        const entry = pending.get(String(id));
        if (!entry) return;
        pending.delete(String(id));
        clearTimeout(entry.timer);
        entry.resolve(message);
    };

    const onData = (chunk) => {
        buffer += String(chunk);
        for (;;) {
            const index = buffer.indexOf('\n');
            if (index < 0) break;
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (line) handleLine(line);
        }
    };

    child.stdout.setEncoding?.('utf8');
    child.stdout.on('data', onData);
    child.stderr.setEncoding?.('utf8');
    child.stderr.on('data', (chunk) => {
        errors += String(chunk);
        if (errors.length > 8192) errors = errors.slice(-8192);
        onStderr?.(String(chunk));
    });
    child.once('error', (error) => failAll(error));
    child.once('close', (code) => failAll(new Error(`The MCP server stopped (code ${code}).`)));

    /**
     * Send a request and wait for its answer.
     * @param {object} message
     * @returns {Promise<object>}
     * @ai.hint io
     */
    const send = (message) => {
        if (closed) return Promise.reject(new Error('The MCP server is not running.'));
        const key = String(message?.id);
        const promise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(key);
                reject(new Error(`The MCP server did not answer in ${timeoutMs} ms.`));
            }, timeoutMs);
            timer.unref?.();
            pending.set(key, { resolve, reject, timer });
        });
        try {
            child.stdin.write(`${JSON.stringify(message)}\n`);
        } catch (error) {
            const entry = pending.get(key);
            if (entry) {
                clearTimeout(entry.timer);
                pending.delete(key);
            }
            return Promise.reject(error);
        }
        return promise;
    };

    /**
     * Send a notification.
     * @param {object} message
     * @returns {void}
     * @ai.hint io
     */
    const notify = (message) => {
        if (closed) return;
        try {
            child.stdin.write(`${JSON.stringify(message)}\n`);
        } catch { /* the pipe is closed */ }
    };

    return {
        transport: { send, notify, close: () => { closed = true; child.kill(); } },
        process: child,
        stderr: () => errors,
        async close() {
            closed = true;
            failAll(new Error('The MCP server is closed.'));
            try { child.stdin.end(); } catch { /* the pipe is closed */ }
            child.kill();
        },
    };
}
