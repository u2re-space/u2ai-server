/**
 * @file src/cli/doctor.js
 * @module cli/doctor
 * @purpose The `doctor` command: a check of the environment before the work starts.
 *
 *   The command answers with a list of checks. Every check has a name, a state
 *   (`ok`, `warn` or `fail`) and a short detail. The command fails when a check
 *   failed: the server cannot work without the Node.js, the configuration and the
 *   key of the model.
 *
 *   The check of the port is a real one: the port of the configuration is bound
 *   for a moment and released, so a busy port is seen before the server starts
 *   and not after.
 *
 * @depends node:net, node:fs/promises, cli/compatibility, config/index, config/paths,
 *          client/proxy, server/serve
 * @usedBy cli
 * @exports runDoctor, formatDoctor
 * @ai.tags cli, doctor, diagnostics
 * @ai.hint io
 */

import net from 'node:net';
import { stat } from 'node:fs/promises';
import { checkNodeVersion } from './compatibility.js';
import { loadConfig } from '../config/index.js';
import { defaultHome, homeConfigFile, homeMcpFile, serveFile } from '../config/paths.js';
import { listServices } from '../client/proxy.js';
import { readServeRecord, pidAlive } from '../server/serve.js';

/** The states of a check. */
export const CHECK_STATES = Object.freeze(['ok', 'warn', 'fail']);

/**
 * One check of the report.
 * @param {string} name
 * @param {'ok'|'warn'|'fail'} status
 * @param {string} detail
 * @returns {{ name: string, status: string, detail: string }}
 * @ai.hint pure
 */
function check(name, status, detail) {
    return { name, status, detail };
}

/**
 * Whether the port can be taken right now.
 * @param {number} port
 * @param {string} host
 * @returns {Promise<boolean>}
 * @ai.hint io
 */
function portFree(port, host) {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.unref();
        server.once('error', () => resolve(false));
        server.listen({ port, host, exclusive: true }, () => {
            server.close(() => resolve(true));
        });
    });
}

/**
 * Run every check of the environment.
 *
 * The configuration is loaded once and shared by the checks: a broken
 * configuration is one failure, not five.
 *
 * @param {{ env?: object, cwd?: string, configPath?: string|null, config?: object|null,
 *           port?: number|null }} [options]
 * @returns {Promise<{ checks: Array<{ name: string, status: string, detail: string }>,
 *           ok: boolean }>}
 * @exports
 * @ai.hint io
 */
export async function runDoctor({
    env = process.env,
    cwd = process.cwd(),
    configPath = null,
    config: given = null,
    port = null,
} = {}) {
    const checks = [];
    const runtime = checkNodeVersion();
    checks.push(check(
        'node',
        runtime.ok ? 'ok' : 'fail',
        runtime.ok ? `v${runtime.version}` : `v${runtime.version}, the package needs Node.js ${runtime.required}`,
    ));

    const home = defaultHome(env);
    const homeInfo = await stat(home).catch(() => null);
    checks.push(check(
        'home',
        homeInfo?.isDirectory() ? 'ok' : 'warn',
        homeInfo?.isDirectory() ? home : `${home} does not exist yet, it will be created`,
    ));

    const configFile = homeConfigFile(home);
    const configInfo = await stat(configFile).catch(() => null);
    checks.push(check(
        'config',
        configInfo?.isFile() ? 'ok' : 'warn',
        configInfo?.isFile() ? configFile : `${configFile} does not exist, the defaults are used`,
    ));

    let config = given;
    let configError = null;
    if (!config) {
        try {
            config = await loadConfig({ configPath, cwd, env, ensureHome: false });
        } catch (error) {
            configError = error?.message ?? String(error);
        }
    }
    checks.push(check(
        'configuration',
        configError ? 'fail' : 'ok',
        configError ?? (config?.configFiles?.join(', ') ?? configFile),
    ));

    const apiKey = typeof config?.apiKey === 'string' && config.apiKey.trim()
        ? config.apiKey.trim()
        : (typeof env.AI_SERVE_API_KEY === 'string' && env.AI_SERVE_API_KEY.trim()
            ? env.AI_SERVE_API_KEY.trim()
            : (typeof env.OPENAI_API_KEY === 'string' && env.OPENAI_API_KEY.trim()
                ? env.OPENAI_API_KEY.trim()
                : ''));
    checks.push(check(
        'key',
        apiKey ? 'ok' : 'fail',
        apiKey ? 'the key of the model is set' : 'no key: set OPENAI_API_KEY or AI_SERVE_API_KEY',
    ));

    const model = typeof config?.model === 'string' && config.model.trim() ? config.model.trim() : '';
    checks.push(check(
        'model',
        model ? 'ok' : 'warn',
        model || 'no model is set, the default of the package is used',
    ));

    const record = await readServeRecord(serveFile(home));
    const wanted = Number.isSafeInteger(port) && port >= 0
        ? port
        : (Number.isSafeInteger(config?.server?.port) ? config.server.port : 0);
    if (record && pidAlive(record.pid)) {
        checks.push(check('port', 'ok', `the server runs on ${record.url} (pid ${record.pid})`));
    } else if (wanted === 0) {
        checks.push(check('port', 'ok', 'a free port will be chosen'));
    } else {
        const free = await portFree(wanted, '127.0.0.1');
        checks.push(check('port', free ? 'ok' : 'warn', free ? `${wanted} is free` : `${wanted} is busy`));
    }

    const mcpFile = homeMcpFile(home);
    const mcpInfo = await stat(mcpFile).catch(() => null);
    const services = Array.isArray(config?.services) ? config.services : [];
    const rows = await listServices(services).catch(() => []);
    const states = new Set(rows.map((row) => row.status));
    checks.push(check(
        'services',
        rows.length === 0 ? 'ok' : (states.has('running') || states.has('configured') ? 'ok' : 'warn'),
        rows.length === 0
            ? 'no external service is registered'
            : rows.map((row) => `${row.name}: ${row.status}`).join(', '),
    ));
    checks.push(check(
        'mcp',
        mcpInfo?.isFile() ? 'ok' : 'warn',
        mcpInfo?.isFile() ? mcpFile : `${mcpFile} does not exist, no external MCP server is registered`,
    ));

    const ok = !checks.some((item) => item.status === 'fail');
    return { checks, ok };
}

/**
 * The report of the doctor as text.
 * @param {Array<{ name: string, status: string, detail: string }>} checks
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function formatDoctor(checks) {
    const width = Math.max(0, ...checks.map((item) => item.name.length));
    return checks.map((item) => `${item.status.padEnd(4)} ${item.name.padEnd(width)}  ${item.detail}`).join('\n');
}
