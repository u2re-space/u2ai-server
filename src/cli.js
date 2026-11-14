/**
 * @file src/cli.js
 * @module cli
 * @purpose Parse argv, dispatch the commands, and map the failures to the exit codes.
 * @depends node:module, cli/parser, cli/compatibility, config, help
 * @exports EXIT, main
 * @ai.tags cli, dispatch
 * @ai.hint keep
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseArgv } from './cli/parser.js';
import { checkNodeVersion } from './cli/compatibility.js';
import { loadConfig, redactConfig } from './config.js';
import { startServe, readServeRecord, pidAlive } from './server/serve.js';
import { serveFile } from './config/paths.js';
import { createHub } from './server/u2ai.js';
import { createMcpServer, startStdioServer, startHttpServer, newMcpToken } from './server/mcp.js';
import { createClient } from './openai/client.js';
import { ROLE_NAMES, runRole, runAgent } from './roles/index.js';
import { HELP, COMMAND_NAMES } from './help.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

/** The exit codes of the CLI. */
export const EXIT = Object.freeze({ ok: 0, failure: 1, usage: 2, aborted: 130 });

/**
 * A usage error: the message goes to stderr and the exit code is 2.
 * @param {string} message
 * @returns {number}
 * @ai.hint io
 */
function usage(message) {
    console.error(message);
    console.error('Run `ai-serve --help` for the commands and the options.');
    return EXIT.usage;
}

/**
 * The commands that are not built yet. They are listed so that the CLI answers with a clear
 * sentence instead of a stack trace.
 * @param {string} command
 * @returns {number}
 * @ai.hint io
 */
function pending(command) {
    return usage(`The command \`${command}\` is not built yet.`);
}

/**
 * The `config` command: the resolved configuration, with the secrets shortened.
 * @param {object} opts
 * @returns {Promise<number>}
 * @ai.hint io
 */
async function commandConfig(opts) {
    let config;
    try {
        config = await loadConfig({ configPath: opts.configPath, cwd: opts.cwd ? path.resolve(opts.cwd) : process.cwd() });
    } catch (error) {
        console.error(error?.message ?? String(error));
        return EXIT.failure;
    }
    const safe = redactConfig(config);
    console.log(JSON.stringify(safe, null, 2));
    return EXIT.ok;
}

/**
 * The port of the server: the flag wins over the config, and an empty flag means the
 * config.
 * @param {string|null} flag
 * @param {object} config
 * @returns {number}
 * @ai.hint pure
 */
function resolvePort(flag, config) {
    if (flag != null && String(flag).trim() !== '') {
        const port = Number(flag);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
            throw new Error('--port: 0..65535');
        }
        return port;
    }
    const configured = config?.server?.port;
    return Number.isSafeInteger(configured) && configured >= 0 && configured <= 65535 ? configured : 0;
}

/**
 * The `serve` command: run the bus and the HTTP part, and write `serve.json`.
 *
 * The command runs until the process is interrupted. The file with the address of the
 * server is removed on the way out.
 * @param {object} opts
 * @returns {Promise<number>}
 * @ai.hint io
 */
async function commandServe(opts) {
    const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
    let config;
    try {
        config = await loadConfig({ configPath: opts.configPath, cwd });
    } catch (error) {
        console.error(error?.message ?? String(error));
        return EXIT.failure;
    }

    let port;
    try {
        port = resolvePort(opts.port, config);
    } catch (error) {
        return usage(error.message);
    }

    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);

    const token = randomBytes(32).toString('hex');
    // The bus is alive; the agent behind it arrives with the roles of the plan.
    const hub = createHub({
        token,
        onStart: async () => {
            throw new Error('The agent of the server is not built yet.');
        },
    });

    let handle;
    try {
        handle = await startServe({
            home: config.home,
            config,
            port,
            host: config.server?.host ?? '127.0.0.1',
            token,
            hub,
            // The MCP endpoint of the server: the same port and the same token.
            mcp: createMcpServer({ root: cwd, config }),
        });
    } catch (error) {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        console.error(error?.message ?? String(error));
        return EXIT.failure;
    }

    console.log(`Bus: ${handle.url}`);
    console.log(`HTTP: ${handle.httpURL}`);
    console.log(`MCP: ${handle.httpURL.replace(/\/$/, '')}/mcp`);
    if (handle.file) console.log(`File: ${handle.file}`);
    console.log('Press Ctrl+C to stop.');

    await new Promise((resolve) => {
        if (controller.signal.aborted) resolve();
        else controller.signal.addEventListener('abort', resolve, { once: true });
    });

    hub.shutdown();
    await handle.close();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    return EXIT.ok;
}

/**
 * The `mcp` command: run the MCP server alone.
 *
 * Over stdio the server speaks the protocol with the client of the editor; over HTTP it
 * listens on a port and takes the token of the running bus, when there is one.
 * @param {object} opts
 * @returns {Promise<number>}
 * @ai.hint io
 */
async function commandMcp(opts) {
    const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
    let config;
    try {
        config = await loadConfig({ configPath: opts.configPath, cwd });
    } catch (error) {
        console.error(error?.message ?? String(error));
        return EXIT.failure;
    }

    let port;
    try {
        port = resolvePort(opts.port, config);
    } catch (error) {
        return usage(error.message);
    }

    const server = createMcpServer({ root: cwd, config });

    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);

    if (!opts.http) {
        const handle = startStdioServer({ server });
        // The client closed the stream: the server stops with it.
        process.stdin.once('end', stop);
        await new Promise((resolve) => {
            if (controller.signal.aborted) resolve();
            else controller.signal.addEventListener('abort', resolve, { once: true });
        });
        handle.close();
        process.stdin.off('end', stop);
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        return EXIT.ok;
    }

    // The token of the bus is the token of the server: the client of the editor knows it.
    const record = await readServeRecord(serveFile(config.home));
    const token = record && pidAlive(record.pid) ? record.token : newMcpToken();
    let handle;
    try {
        handle = await startHttpServer({
            server,
            port,
            host: config.server?.host ?? '127.0.0.1',
            token,
        });
    } catch (error) {
        console.error(error?.message ?? String(error));
        return EXIT.failure;
    }

    console.log(`MCP: ${handle.url}`);
    console.log(`Token: ${token}`);
    console.log('Press Ctrl+C to stop.');

    await new Promise((resolve) => {
        if (controller.signal.aborted) resolve();
        else controller.signal.addEventListener('abort', resolve, { once: true });
    });

    await handle.close();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    return EXIT.ok;
}

/**
 * The `agent` command: run a task as an AI agent.
 *
 * Without a role the agent analyzes the task, plans the work and does it. With a role
 * it runs that role alone: `analyzer`, `director`, `executor`, `tooler` or `suggester`.
 *
 * @param {object} opts
 * @returns {Promise<number>}
 * @ai.hint io
 */
async function commandAgent(opts) {
    const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
    const task = opts.task ?? opts.positionals.join(' ').trim();
    if (!task) return usage('The command `agent` needs a task.');

    let config;
    try {
        config = await loadConfig({ configPath: opts.configPath, cwd });
    } catch (error) {
        console.error(error?.message ?? String(error));
        return EXIT.failure;
    }

    const role = opts.role ?? 'agent';
    if (role !== 'agent' && !ROLE_NAMES.includes(role)) {
        return usage(`There is no role named ${role}. The roles are: ${ROLE_NAMES.join(', ')}.`);
    }

    const onEvent = opts.verbose
        ? (event) => console.error(`[${event?.type ?? 'event'}] ${event?.error ?? event?.backend ?? ''}`)
        : null;
    let client;
    try {
        client = await createClient({ config, env: process.env, onEvent });
    } catch (error) {
        console.error(error?.message ?? String(error));
        return EXIT.failure;
    }

    try {
        if (role === 'agent') {
            const out = await runAgent({
                task,
                config,
                client,
                root: cwd,
                model: opts.model ?? null,
            });
            printAgentResult(out, opts.json);
        } else {
            const out = await runRole(role, {
                task,
                config,
                client,
                root: cwd,
                model: opts.model ?? null,
            });
            printRoleResult(role, out, opts.json);
        }
    } catch (error) {
        console.error(error?.message ?? String(error));
        return EXIT.failure;
    }
    return EXIT.ok;
}

/**
 * The answer of the agent, as JSON or as text.
 * @param {object} out
 * @param {boolean} asJson
 * @returns {void}
 * @ai.hint io
 */
function printAgentResult(out, asJson) {
    if (asJson) {
        console.log(JSON.stringify(out, null, 2));
        return;
    }
    console.log('Analysis:');
    console.log(`- goal: ${out.analysis.goal || '(none)'}`);
    for (const file of out.analysis.files) console.log(`- ${file.role} ${file.path} — ${file.reason}`);
    console.log('');
    console.log('Plan:');
    for (const step of out.plan.steps) console.log(`- ${step.id}: ${step.title || step.action}`);
    console.log('');
    console.log('Work:');
    for (const step of out.execution.steps) console.log(`- ${step.id}: ${step.status} — ${step.note}`);
    console.log(out.execution.summary);
}

/**
 * The answer of one role, as JSON or as text.
 * @param {string} role
 * @param {object} out
 * @param {boolean} asJson
 * @returns {void}
 * @ai.hint io
 */
function printRoleResult(role, out, asJson) {
    const body = {
        analyzer: { analysis: out.analysis },
        director: { plan: out.plan },
        executor: { steps: out.steps, summary: out.summary, changes: out.changes },
        tooler: { tool: out.tool, arguments: out.arguments, reason: out.reason, result: out.result },
        suggester: { suggestion: out.suggestion },
    }[role] ?? out;
    if (asJson) {
        console.log(JSON.stringify(body, null, 2));
        return;
    }
    if (role === 'analyzer') {
        console.log(`Goal: ${out.analysis.goal || '(none)'}`);
        for (const file of out.analysis.files) console.log(`- ${file.role} ${file.path} — ${file.reason}`);
        return;
    }
    if (role === 'director') {
        for (const step of out.plan.steps) console.log(`- ${step.id}: ${step.title || step.action}`);
        return;
    }
    if (role === 'executor') {
        for (const step of out.steps) console.log(`- ${step.id}: ${step.status} — ${step.note}`);
        console.log(out.summary);
        return;
    }
    if (role === 'tooler') {
        console.log(`Tool: ${out.tool || '(none)'}`);
        if (out.reason) console.log(`Reason: ${out.reason}`);
        if (out.result?.text) console.log(out.result.text);
        return;
    }
    console.log(out.suggestion?.answer ?? '');
    for (const hint of out.suggestion?.hints ?? []) console.log(`- ${hint}`);
}

/**
 * Main entry point: parse the arguments and dispatch the command.
 * @param {string[]} argv
 * @returns {Promise<number>} the exit code
 * @exports
 * @ai.hint io
 */
export async function main(argv = process.argv.slice(2)) {
    const opts = parseArgv(argv);
    if (opts.help) {
        console.log(HELP);
        return EXIT.ok;
    }
    if (opts.version) {
        console.log(pkg.version);
        return EXIT.ok;
    }

    const runtime = checkNodeVersion();
    if (!runtime.ok) {
        console.error(`Node.js ${runtime.required} is required, this is ${runtime.version}.`);
        return EXIT.failure;
    }

    if (opts.command === 'config') {
        return await commandConfig(opts);
    }
    if (opts.command === 'serve') {
        return await commandServe(opts);
    }
    if (opts.command === 'mcp') {
        return await commandMcp(opts);
    }
    if (opts.command === 'agent') {
        return await commandAgent(opts);
    }
    if (COMMAND_NAMES.includes(opts.command)) {
        return pending(opts.command);
    }
    return usage(`Unknown command: ${opts.command}.`);
}
