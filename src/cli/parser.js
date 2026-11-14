/**
 * @file src/cli/parser.js
 * @module cli/parser
 * @purpose Parse the arguments of the CLI into the options the commands read.
 * @depends node:util, help
 * @exports parseArgv
 * @ai.hint keep
 */

import { parseArgs } from 'node:util';
import { COMMAND_NAMES } from '../help.js';

/**
 * Parse the arguments of the CLI.
 *
 * The first positional is the command when it names one; anything else is an input of the
 * command, so `ai-serve agent "fix the tests"` means the agent command with that task.
 *
 * @param {string[]} argv
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function parseArgv(argv) {
    const parsed = parseArgs({
        options: {
            port: { type: 'string' },
            cwd: { type: 'string' },
            config: { type: 'string', short: 'c' },
            file: { type: 'string', short: 'f' },
            line: { type: 'string' },
            language: { type: 'string' },
            model: { type: 'string', short: 'm' },
            effort: { type: 'string' },
            task: { type: 'string' },
            http: { type: 'boolean', default: false },
            stdio: { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
            verbose: { type: 'boolean', default: false },
            help: { type: 'boolean', short: 'h', default: false },
            version: { type: 'boolean', short: 'v', default: false },
        },
        strict: false,
        allowPositionals: true,
        args: argv,
    });

    const positionals = [...parsed.positionals];
    let command = 'serve';
    if (positionals.length && COMMAND_NAMES.includes(positionals[0])) {
        command = positionals.shift();
    }

    return {
        command,
        positionals,
        port: parsed.values.port ?? null,
        cwd: parsed.values.cwd ?? null,
        configPath: parsed.values.config ?? null,
        file: parsed.values.file ?? null,
        line: parsed.values.line ?? null,
        language: parsed.values.language ?? null,
        model: parsed.values.model ?? null,
        effort: parsed.values.effort ?? null,
        task: parsed.values.task ?? positionals[0] ?? null,
        http: parsed.values.http === true,
        stdio: parsed.values.stdio === true,
        json: parsed.values.json === true,
        verbose: parsed.values.verbose === true,
        help: parsed.values.help === true,
        version: parsed.values.version === true,
    };
}
