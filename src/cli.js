/**
 * @file src/cli.js
 * @module cli
 * @purpose Parse argv, dispatch the commands, and map the failures to the exit codes.
 * @depends node:module, cli/parser, cli/compatibility, cli/doctor, config, help
 * @exports EXIT, main
 * @ai.tags cli, dispatch
 * @ai.hint keep
 */

import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { parseArgv } from './cli/parser.js';
import { checkNodeVersion } from './cli/compatibility.js';
import { createPlainRenderer, createRenderer, detectMode } from './cli/renderer.js';
import { runDoctor, formatDoctor } from './cli/doctor.js';
import { loadConfig, redactConfig } from './config.js';
import { readMcpFile, registerService, removeService, registerMcpServer, removeMcpServer } from './config/parser.js';
import { defaultHome, homeConfigFile, homeMcpFile, serveFile } from './config/paths.js';
import { startServe, readServeRecord, pidAlive } from './server/serve.js';
import { signRun } from './server/publish.js';
import { createHub } from './server/u2ai.js';
import { createServerAgent } from './server/agent.js';
import { createMcpServer, startHttpServer, newMcpToken } from './server/mcp.js';
import { startStdioServer } from './server/stdio.js';
import { createClient } from './openai/client.js';
import { completeAtCursor } from './agent/autocomplete.js';
import { discoverSkills, skillsDirectory } from './agent/skills.js';
import { TOOL_NAMES, TOOL_SPECS, toolAllowed } from './tools/tools.js';
import { normalizeServer, listServices, createToolProxy } from './client/proxy.js';
import { ROLE_NAMES, runRole, runAgent, roleToolNames } from './roles/index.js';
import { callTool } from './roles/tooler.js';
import { createRoleSubagentSpawner } from './agent/role-subagent.js';
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
 * @param {{ renderer?: object|null }} [context] the renderer of the events of the runs
 * @returns {Promise<number>}
 * @ai.hint io
 */
async function commandServe(opts, context = {}) {
    const renderer = context.renderer ?? null;
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
    // The bus is alive, and the agent behind it answers the runs of the clients. The
    // agent needs the hub and the hub needs the agent: the link is closed here.
    let agent = null;
    const hub = createHub({
        token,
        onStart: (run, frame) => (agent
            ? agent.start(run, frame)
            : Promise.reject(new Error('The agent of the server is not ready yet.'))),
    });
    agent = createServerAgent({
        hub,
        config,
        root: cwd,
        approve: config.server?.approve ?? 'ask',
        // The events of the runs are shown to the person at the terminal too: the service
        // is alive, and the reader sees what it is doing.
        onEvent: (run, event) => renderer?.event?.(event),
    });

    // The bridge of the completion. The client of the API is made on the first request,
    // so the server starts even when the keys of the backends are not set yet.
    let clientPromise = null;
    const completionClient = () => {
        if (!clientPromise) clientPromise = createClient({ config, env: process.env });
        return clientPromise;
    };
    const onComplete = async (frame) => {
        const client = await completionClient();
        const out = await completeAtCursor({ client, config, frame });
        return { id: out.id, text: out.text };
    };

    let handle;
    try {
        handle = await startServe({
            home: config.home,
            config,
            port,
            host: config.server?.host ?? '127.0.0.1',
            token,
            hub,
            onComplete,
            // The list of the tools of the configuration: the model sees the same list.
            // The tools of the clients of the bus are in the list too.
            tools: () => [
                ...TOOL_NAMES
                    .filter((name) => toolAllowed(name, config))
                    .map((name) => ({
                        name,
                        category: TOOL_SPECS[name].category,
                        risk: TOOL_SPECS[name].risk,
                        description: TOOL_SPECS[name].description,
                    })),
                ...hub.listClientTools().map((tool) => ({
                    name: tool.name,
                    category: 'client',
                    risk: 'medium',
                    description: tool.description,
                    client: tool.client,
                })),
            ],
            // The MCP endpoint of the server: the same port and the same token. It
            // publishes the tools of the clients of the bus and calls them.
            mcp: createMcpServer({
                root: cwd,
                config,
                listClientTools: () => hub.listClientTools(),
                callClientTool: (toolName, args) => hub.callClientTool(toolName, args),
            }),
        });
    } catch (error) {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        console.error(error?.message ?? String(error));
        return EXIT.failure;
    }

    console.log(`Bus: ${handle.url}`);
    console.log(`HTTP: ${handle.httpURL}`);
    console.log(`Complete: ${handle.complete}`);
    console.log(`MCP: ${handle.mcp}`);
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

    // The run of the agent: its id names the directory of its state in the house.
    const runId = randomUUID();
    const changes = [];
    let status = 'failed';

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

    // The external MCP servers are a source of tools: the model calls them by the name
    // of the proxy, and the call goes to the server that owns the tool.
    let proxy = null;
    const servers = Array.isArray(config.mcpServers) ? config.mcpServers : [];
    if (servers.length) {
        try {
            proxy = await createToolProxy(servers, { env: process.env });
            for (const failure of proxy.errors) {
                console.error(`The MCP server ${failure.name} is not available: ${failure.message}`);
            }
        } catch (error) {
            console.error(error?.message ?? String(error));
            return EXIT.failure;
        }
    }

    try {
        // The hand-over to a sub-agent: the roles of the CLI may hand one bounded piece
        // of work to a separate worker. The sub-agent inherits the tools of the run and
        // its rights: it works in the same project, and the files it writes are written
        // by the tools of this process.
        const subagent = createRoleSubagentSpawner({
            config,
            root: cwd,
            depth: 0,
            notify: (event) => {
                if (opts.verbose) console.error(`[${event?.type ?? 'subagent'}] ${event?.to ?? ''}`);
            },
            // The executor of this process: the tools of the run, with their own rules.
            executor: async (name, args) => {
                const result = await callTool(name, args, { root: cwd, config, signal: null });
                if (!result.ok) throw new Error(result.error ?? 'The tool failed.');
                return result.text;
            },
            // The instructions of the inherited role: the words of the run, plus the note
            // that the sub-agent works alone.
            instructions: [
                'You work alone in a separate worker: you do not see the conversation of the run.',
                'Do the bounded work the goal names, write the files it names, and report what you did.',
            ].filter(Boolean).join('\n\n'),
            // The tools of a role: the mode of the role, cut by the run.
            toolNamesFor: () => roleToolNames(config, 'executor').filter((tool) => tool !== 'subagent'),
            // The tools the executor really runs: the tools of the run.
            specs: roleToolNames(config, 'executor'),
            model: opts.model ?? config?.model ?? null,
            effort: config?.reasoning?.effort ?? null,
            baseURL: config?.baseURL ?? null,
            apiKey: config?.apiKey ?? null,
        });
        if (role === 'agent') {
            const out = await runAgent({
                task,
                config,
                client,
                root: cwd,
                model: opts.model ?? null,
                proxy,
                subagent,
            });
            if (Array.isArray(out.execution?.changes)) changes.push(...out.execution.changes);
            printAgentResult(out, opts.json);
        } else {
            const out = await runRole(role, {
                task,
                config,
                client,
                root: cwd,
                model: opts.model ?? null,
                proxy,
                subagent,
            });
            if (Array.isArray(out?.changes)) changes.push(...out.changes);
            printRoleResult(role, out, opts.json);
        }
        status = 'completed';
    } catch (error) {
        console.error(error?.message ?? String(error));
        return EXIT.failure;
    } finally {
        // The house of the project: the state of the run and the files it wrote.
        const signed = await signRun(cwd, runId, {
            changes,
            state: { command: 'agent', role, status, finishedAt: new Date().toISOString() },
        });
        if (!signed.ok) console.error(`The contract of the project is not signed: ${signed.error}`);
        if (proxy) await proxy.close();
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
 * The `doctor` command: the check of the environment.
 *
 * The report is a list of checks: the Node.js, the home directory, the
 * configuration, the key of the model, the port and the external services. The
 * command fails when a check failed.
 *
 * @param {object} opts
 * @returns {Promise<number>}
 * @ai.hint io
 */
async function commandDoctor(opts) {
    const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
    const report = await runDoctor({
        cwd,
        configPath: opts.configPath,
        port: opts.port != null && String(opts.port).trim() !== '' ? Number(opts.port) : null,
    });
    if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        console.log(formatDoctor(report.checks));
    }
    return report.ok ? EXIT.ok : EXIT.failure;
}

/**
 * The `tools` command: the tools of the package, with their category and their risk.
 *
 * The list is the one of the configuration: a tool that the configuration forbids is not
 * printed, because the model does not see it either.
 *
 * @param {object} opts
 * @returns {Promise<number>}
 * @ai.hint io
 */
async function commandTools(opts) {
    let config = null;
    try {
        config = await loadConfig({
            configPath: opts.configPath,
            cwd: opts.cwd ? path.resolve(opts.cwd) : process.cwd(),
        });
    } catch {
        // The list of the tools does not need the configuration: the defaults are enough.
    }
    const list = TOOL_NAMES
        .filter((name) => toolAllowed(name, config))
        .map((name) => ({
            name,
            category: TOOL_SPECS[name].category,
            risk: TOOL_SPECS[name].risk,
            description: TOOL_SPECS[name].description,
        }));
    if (opts.json) {
        console.log(JSON.stringify(list, null, 2));
        return EXIT.ok;
    }
    for (const tool of list) {
        console.log(`${tool.name.padEnd(18)} ${tool.category.padEnd(6)} ${tool.risk}`);
    }
    return EXIT.ok;
}

/**
 * The `skills` command: the installed Agent Skills of the project and the user.
 * @param {object} opts
 * @returns {Promise<number>}
 * @ai.hint io
 */
async function commandSkills(opts) {
    const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
    let config = null;
    try {
        config = await loadConfig({ configPath: opts.configPath, cwd });
    } catch {
        // The catalogue does not need a valid configuration: the standard directories are enough.
    }
    const skillDir = skillsDirectory(config);
    const skills = await discoverSkills(cwd, {
        extraDirs: skillDir ? [skillDir] : [],
    });
    const list = skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        path: skill.path,
    }));
    if (opts.json) {
        console.log(JSON.stringify(list, null, 2));
        return EXIT.ok;
    }
    if (!list.length) {
        console.log('No skills found. Install one with `npx skills add <package> -g`.');
        return EXIT.ok;
    }
    for (const skill of list) {
        console.log(`${skill.name.padEnd(24)} ${skill.description || 'no description'}`);
    }
    return EXIT.ok;
}

/**
 * The `complete` command: one completion for a file and a line, printed to the stdout.
 *
 * The cursor is at the end of the line: the command continues the line, as the Tab of the
 * editor does. The answer is the text to insert and nothing else.
 *
 * @param {object} opts
 * @returns {Promise<number>}
 * @ai.hint io
 */
async function commandComplete(opts) {
    const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
    const file = opts.file ?? opts.positionals[0] ?? null;
    if (!file) return usage('The command `complete` needs a file: --file <path>.');

    const line = Number(opts.line ?? 1);
    if (!Number.isSafeInteger(line) || line < 1) return usage('--line: 1..');

    const target = path.resolve(cwd, file);
    let content;
    try {
        content = await readFile(target, 'utf8');
    } catch (error) {
        console.error(error?.message ?? String(error));
        return EXIT.failure;
    }

    let config;
    try {
        config = await loadConfig({ configPath: opts.configPath, cwd });
    } catch (error) {
        console.error(error?.message ?? String(error));
        return EXIT.failure;
    }

    const rows = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const index = Math.min(line - 1, Math.max(0, rows.length - 1));
    const cursor = { line: index, character: (rows[index] ?? '').length };

    try {
        const client = await createClient({ config, env: process.env });
        const out = await completeAtCursor({
            client,
            config,
            frame: {
                id: 'cli',
                content,
                cursor,
                path: path.relative(cwd, target) || target,
                language: opts.language ?? undefined,
            },
        });
        if (opts.json) {
            console.log(JSON.stringify({ id: out.id, text: out.text }, null, 2));
            return EXIT.ok;
        }
        process.stdout.write(out.text);
        return EXIT.ok;
    } catch (error) {
        console.error(error?.message ?? String(error));
        return EXIT.failure;
    }
}

/**
 * The `services` command: the external services and their state.
 *
 * The list has three kinds of rows: this server (the file `serve.json` of the home
 * directory), the other `ai-serve` instances of `config.json`, and the external MCP
 * servers of `mcp.json`. The token is shortened in the text and whole in the JSON.
 *
 * @param {object} opts
 * @returns {Promise<number>}
 * @ai.hint io
 */
async function commandServices(opts) {
    const action = opts.positionals[0] ?? 'list';
    if (action === 'add') return await commandServicesAdd(opts);
    if (action === 'add-mcp') return await commandServicesAddMcp(opts);
    if (action === 'remove') return await commandServicesRemove(opts);
    if (action !== 'list') return usage(`Unknown action of \`services\`: ${action}.`);

    let config;
    try {
        config = await loadConfig({
            configPath: opts.configPath,
            cwd: opts.cwd ? path.resolve(opts.cwd) : process.cwd(),
        });
    } catch (error) {
        console.error(error?.message ?? String(error));
        return EXIT.failure;
    }

    const home = config.home;
    const rows = [];
    const self = await readServeRecord(serveFile(home));
    rows.push({
        name: 'self',
        kind: 'ai-serve',
        status: self && pidAlive(self.pid) ? 'running' : 'stopped',
        url: self?.url ?? null,
        httpURL: self?.httpURL ?? null,
        token: self?.token ?? null,
        pid: self?.pid ?? null,
    });
    for (const service of await listServices(config.services)) {
        rows.push({ name: service.name, kind: 'ai-serve', ...service });
    }

    let servers = [];
    try {
        servers = await readMcpFile(homeMcpFile(home));
    } catch (error) {
        console.error(error?.message ?? String(error));
        return EXIT.failure;
    }
    for (const [index, entry] of servers.entries()) {
        let server;
        try {
            server = normalizeServer(entry, index);
        } catch {
            continue;
        }
        rows.push({
            name: server.name,
            kind: 'mcp',
            status: server.enabled ? 'configured' : 'disabled',
            transport: server.transport,
            url: server.url,
            command: server.command,
            token: server.token,
        });
    }

    if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return EXIT.ok;
    }
    console.log(`${'NAME'.padEnd(18)}${'KIND'.padEnd(10)}${'STATUS'.padEnd(12)}${'ADDRESS'.padEnd(32)}TOKEN`);
    for (const row of rows) {
        const address = row.url ?? row.command ?? '';
        console.log(`${row.name.padEnd(18)}${row.kind.padEnd(10)}${row.status.padEnd(12)}${address.padEnd(32)}${maskToken(row.token)}`);
    }
    return EXIT.ok;
}

/**
 * The `services add` action: a service of `config.json`.
 * @param {object} opts
 * @returns {Promise<number>}
 * @ai.hint io
 */
async function commandServicesAdd(opts) {
    const name = opts.positionals[1];
    if (!name) return usage('The action `services add` needs a name.');
    if (!opts.url && !opts.serviceCommand) return usage('The action `services add` needs --url or --command.');
    const entry = {
        name,
        ...(opts.url ? { url: opts.url } : {}),
        ...(opts.serviceCommand ? { command: opts.serviceCommand, args: opts.args } : {}),
        ...(opts.token ? { token: opts.token } : {}),
    };
    try {
        await registerService(homeConfigFile(defaultHome(process.env)), entry);
    } catch (error) {
        console.error(error?.message ?? String(error));
        return EXIT.failure;
    }
    console.log(`Registered the service ${name}.`);
    return EXIT.ok;
}

/**
 * The `services add-mcp` action: an external MCP server of `mcp.json`.
 * @param {object} opts
 * @returns {Promise<number>}
 * @ai.hint io
 */
async function commandServicesAddMcp(opts) {
    const name = opts.positionals[1];
    if (!name) return usage('The action `services add-mcp` needs a name.');
    if (!opts.url && !opts.serviceCommand) return usage('The action `services add-mcp` needs --url or --command.');
    const entry = {
        name,
        ...(opts.url
            ? { url: opts.url, ...(opts.token ? { token: opts.token } : {}) }
            : { command: opts.serviceCommand, args: opts.args, ...(opts.token ? { token: opts.token } : {}) }),
    };
    try {
        await registerMcpServer(homeMcpFile(defaultHome(process.env)), entry);
    } catch (error) {
        console.error(error?.message ?? String(error));
        return EXIT.failure;
    }
    console.log(`Registered the MCP server ${name}.`);
    return EXIT.ok;
}

/**
 * The `services remove` action: the service goes from both files.
 * @param {object} opts
 * @returns {Promise<number>}
 * @ai.hint io
 */
async function commandServicesRemove(opts) {
    const name = opts.positionals[1];
    if (!name) return usage('The action `services remove` needs a name.');
    const home = defaultHome(process.env);
    let removed = false;
    try {
        removed = await removeService(homeConfigFile(home), name);
        removed = (await removeMcpServer(homeMcpFile(home), name)) || removed;
    } catch (error) {
        console.error(error?.message ?? String(error));
        return EXIT.failure;
    }
    if (!removed) {
        console.error(`There is no service named ${name}.`);
        return EXIT.failure;
    }
    console.log(`Removed the service ${name}.`);
    return EXIT.ok;
}

/**
 * The token of a row, shortened for the text output.
 * @param {string|null|undefined} token
 * @returns {string}
 * @ai.hint pure
 */
function maskToken(token) {
    if (typeof token !== 'string' || !token) return '-';
    if (token.length <= 6) return '…';
    return `${token.slice(0, 3)}…${token.slice(-2)}`;
}

/**
 * Main entry point: parse the arguments and dispatch the command.
 *
 * The renderer may come from the worker: the graphical shell runs the same command in its
 * own process and listens to the events over the protocol.
 * @param {string[]} argv
 * @param {{ renderer?: object|null, input?: object|null }} [options]
 * @returns {Promise<number>} the exit code
 * @exports
 * @ai.hint io
 */
export async function main(argv = process.argv.slice(2), { renderer: given = null, input = null } = {}) {
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

    // The renderer of the events of the runs: the worker sends them to the shell, the plain
    // CLI prints them as lines.
    const mode = opts.flags.json ? 'json' : (opts.flags.quiet ? 'quiet' : 'plain');
    const renderer = given ?? (detectMode() === 'tty'
        ? createRenderer({ verbose: opts.verbose, mode })
        : createPlainRenderer({ verbose: opts.verbose, mode }));
    const context = { renderer, input };

    if (opts.command === 'config') {
        return await commandConfig(opts);
    }
    if (opts.command === 'serve') {
        return await commandServe(opts, context);
    }
    if (opts.command === 'mcp') {
        return await commandMcp(opts);
    }
    if (opts.command === 'agent') {
        return await commandAgent(opts, context);
    }
    if (opts.command === 'tools') {
        return await commandTools(opts);
    }
    if (opts.command === 'skills') {
        return await commandSkills(opts);
    }
    if (opts.command === 'complete') {
        return await commandComplete(opts);
    }
    if (opts.command === 'services') {
        return await commandServices(opts);
    }
    if (opts.command === 'doctor') {
        return await commandDoctor(opts);
    }
    if (COMMAND_NAMES.includes(opts.command)) {
        return pending(opts.command);
    }
    return usage(`Unknown command: ${opts.command}.`);
}
