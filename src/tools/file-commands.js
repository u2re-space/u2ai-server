/**
 * @file src/tools/file-commands.js
 * @module tools/file-commands
 * @purpose Run a batch of file commands in one call: read, write, and list.
 *
 *   The model often wants to change three files at once. Three separate tool calls cost
 *   three round trips and three approvals; one batch costs one. The batch is checked
 *   before it runs: the shape of every command, then the path of every command, so a
 *   batch that touches a secret or leaves the root never writes anything.
 *
 *   The order matters: every command is checked first, and only a checked batch runs.
 *   A batch that fails in the middle keeps the changes it already made and says which
 *   command failed.
 *
 * @depends agent/access, tools/filesystem
 * @usedBy tools/tools, agent/roles
 * @exports FILE_COMMANDS_SCHEMA, CommandBatchError, executeFileCommands
 * @ai.tags files, batch
 * @ai.hint io
 */

import { resolveInside } from '../agent/access.js';
import { listFiles, readTextFile, writeTextFile } from './filesystem.js';

/**
 * A strict object schema: every property is required, the extras are refused.
 * @param {object} properties
 * @returns {object}
 * @ai.hint pure
 */
const object = (properties) => ({
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
});

/**
 * The schema of a batch of file commands.
 *
 * The model answers with it, so the names are short: `fs:read`, `fs:write`, `fs:list`.
 * @type {object}
 * @exports
 * @ai.hint pure
 */
export const FILE_COMMANDS_SCHEMA = object({
    summary: { type: 'string', description: 'What these file commands do.' },
    commands: {
        type: 'array',
        description: 'The commands to run, in order.',
        items: object({
            command: { type: 'string', enum: ['fs:read', 'fs:write', 'fs:list'], description: 'fs:read reads a file, fs:write writes one, fs:list lists a directory.' },
            path: { type: 'string', description: 'The path of the file or the directory, relative to the working directory.' },
            content: { type: ['string', 'null'], description: 'The whole content of the file for fs:write. Null for the other commands.' },
            start_line: { type: ['integer', 'null'], description: 'The first line to read (1-based) for fs:read. Null = from the beginning.' },
            end_line: { type: ['integer', 'null'], description: 'The last line to read (inclusive) for fs:read. Null = to the end.' },
            depth: { type: ['integer', 'null'], description: 'How many levels deep to list for fs:list. Null = 2.' },
        }),
    },
});

/**
 * A batch that failed its check, or stopped while it was running.
 */
export class CommandBatchError extends Error {
    /**
     * @param {string} message
     * @param {{ fatal?: boolean, changes?: string[], written?: string[] }} [options]
     *   fatal means nothing of the batch ran.
     */
    constructor(message, options = {}) {
        super(message);
        this.name = 'CommandBatchError';
        this.fatal = options.fatal ?? false;
        this.changes = options.changes ?? [];
        this.written = options.written ?? [];
    }
}

/**
 * Check the shape of one command.
 * @param {object} command
 * @param {number} index
 * @returns {void}
 * @ai.hint pure
 */
function checkShape(command, index) {
    const where = `commands[${index}]`;
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
        throw new CommandBatchError(`The file commands: ${where} must be an object.`, { fatal: true });
    }
    if (!['fs:read', 'fs:write', 'fs:list'].includes(command.command)) {
        throw new CommandBatchError(`The file commands: ${where}.command must be fs:read, fs:write or fs:list.`, { fatal: true });
    }
    if (typeof command.path !== 'string' || !command.path.trim()) {
        throw new CommandBatchError(`The file commands: ${where}.path must be a non-empty string.`, { fatal: true });
    }
    if (command.command === 'fs:write' && typeof command.content !== 'string') {
        throw new CommandBatchError(`The file commands: ${where}.content must be a string for fs:write.`, { fatal: true });
    }
    for (const key of ['start_line', 'end_line', 'depth']) {
        const value = command[key];
        if (value != null && (!Number.isSafeInteger(value) || value < 1)) {
            throw new CommandBatchError(`The file commands: ${where}.${key} must be a positive integer.`, { fatal: true });
        }
    }
}

/**
 * Run a batch of file commands.
 *
 * @param {{ root: string, commands: object[], backupDir?: string|null,
 *           maxBytes?: number }} options
 * @returns {Promise<{ text: string, summary: string, results: object[],
 *           written: string[], changes: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function executeFileCommands({ root, commands, backupDir = null, maxBytes = 4 * 1024 * 1024 } = {}) {
    if (!Array.isArray(commands) || !commands.length) {
        throw new CommandBatchError('The file commands: the list is empty.', { fatal: true });
    }

    // The shape of every command is checked before the first touch of the disk.
    commands.forEach(checkShape);

    // The path of every command is checked too: a batch that leaves the root never runs.
    const paths = [];
    for (const [index, command] of commands.entries()) {
        try {
            const inside = await resolveInside(root, command.path, {
                forWrite: command.command === 'fs:write',
                allowRoot: command.command !== 'fs:write',
            });
            paths.push(inside.rel);
        } catch (error) {
            throw new CommandBatchError(`The file commands: commands[${index}].path is refused: ${error.message}`, { fatal: true });
        }
    }

    const results = [];
    const written = [];
    const changes = [];

    for (const [index, command] of commands.entries()) {
        try {
            if (command.command === 'fs:read') {
                const out = await readTextFile({
                    root,
                    file: command.path,
                    startLine: command.start_line ?? null,
                    endLine: command.end_line ?? null,
                    maxBytes,
                });
                results.push({ command: command.command, path: paths[index], text: out.text, touches: [paths[index]] });
                continue;
            }
            if (command.command === 'fs:list') {
                const out = await listFiles({
                    root,
                    dir: command.path,
                    depth: command.depth ?? 2,
                });
                results.push({ command: command.command, path: paths[index], text: out.text, touches: [paths[index]] });
                continue;
            }
            const out = await writeTextFile({
                root,
                file: command.path,
                content: command.content,
                overwrite: true,
                maxBytes,
                backupDir,
            });
            written.push(out.rel);
            results.push({ command: command.command, path: out.rel, text: `written: ${out.rel} (${out.bytes} bytes)`, touches: [out.rel] });
        } catch (error) {
            throw new CommandBatchError(`The file commands: commands[${index}] (${command.command}) failed: ${error.message}`, {
                fatal: false,
                changes,
                written,
            });
        }
    }

    const lines = results.map((item) => `${item.command} ${item.path}\n${item.text}`);
    const summary = `${results.length} command(s), ${written.length} written.`;
    return {
        text: `${summary}\n${lines.join('\n')}`,
        summary,
        results,
        written,
        changes,
    };
}
