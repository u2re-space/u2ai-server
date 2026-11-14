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
import { parseArgv } from './cli/parser.js';
import { checkNodeVersion } from './cli/compatibility.js';
import { loadConfig, redactConfig } from './config.js';
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
    if (COMMAND_NAMES.includes(opts.command)) {
        return pending(opts.command);
    }
    return usage(`Unknown command: ${opts.command}.`);
}
