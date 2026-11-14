/**
 * @file src/tools/suggest.js
 * @module tools/suggest
 * @purpose Suggest the paths and the commands that fit the context of the task.
 *
 *   The model guesses the path of a file or the name of a script. A guess that misses
 *   costs a round trip and an error. This module reads the tree of the project once and
 *   answers with the paths that fit the prefix, and with the commands the project really
 *   has — the scripts of `package.json` and the usual ones when the files for them exist.
 *
 *   The search stays inside the root of the run and skips the noisy and the secret files.
 *
 * @depends node:path, node:fs/promises, agent/access, tools/context
 * @usedBy agent/roles, tools/tools, server/mcp
 * @exports suggestPaths, suggestCommands, suggest
 * @ai.tags suggest, paths, commands
 * @ai.hint io
 * @ai.hint legacy-0.2
 */

import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { NOISY_DIRS, isProtectedFileName, isForbiddenDirName, resolveInside } from '../agent/access.js';
import { parseJsonc } from './context.js';

/** How deep the search walks into the tree. */
const MAX_DEPTH = 5;

/** The largest number of the files the search reads. */
const MAX_FILES = 2000;

/** The largest number of the suggestions of one list. */
const MAX_SUGGESTIONS = 12;

/**
 * The relative paths of the tree of the root.
 * @param {string} root
 * @param {{ maxDepth?: number, maxFiles?: number }} [options]
 * @returns {Promise<string[]>}
 * @ai.hint io
 */
async function listTree(root, { maxDepth = MAX_DEPTH, maxFiles = MAX_FILES } = {}) {
    const out = [];
    /**
     * @param {string} directory the absolute path
     * @param {string} relative the path relative to the root
     * @param {number} depth
     * @returns {Promise<void>}
     * @ai.hint io
     */
    const walk = async (directory, relative, depth) => {
        if (depth > maxDepth || out.length >= maxFiles) return;
        const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (out.length >= maxFiles) return;
            const name = entry.name;
            if (name.startsWith('.') && name !== '.env.example') continue;
            if (entry.isDirectory()) {
                if (NOISY_DIRS.test(name) || isForbiddenDirName(name)) continue;
                await walk(path.join(directory, name), relative ? `${relative}/${name}` : name, depth + 1);
                continue;
            }
            if (!entry.isFile()) continue;
            if (isProtectedFileName(name)) continue;
            out.push(relative ? `${relative}/${name}` : name);
        }
    };
    await walk(root, '', 1);
    return out;
}

/**
 * The paths that fit the prefix.
 *
 * A path that starts with the prefix comes first; then the paths whose name or whose
 * segment carries it.
 * @param {{ root: string, prefix?: string, limit?: number }} options
 * @returns {Promise<{ prefix: string, paths: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function suggestPaths({ root, prefix = '', limit = MAX_SUGGESTIONS } = {}) {
    const base = path.resolve(String(root ?? process.cwd()));
    const needle = String(prefix ?? '').trim().replace(/^[./]+/, '').replaceAll('\\', '/').toLowerCase();
    const tree = await listTree(base);
    const exact = [];
    const inside = [];
    const loose = [];
    for (const item of tree) {
        const lower = item.toLowerCase();
        if (!needle) {
            exact.push(item);
            continue;
        }
        if (lower.startsWith(needle)) exact.push(item);
        else if (lower.includes(`/${needle}`)) inside.push(item);
        else if (lower.includes(needle)) loose.push(item);
    }
    const paths = [...exact, ...inside, ...loose].slice(0, Math.max(1, limit));
    return { prefix: needle, paths };
}

/**
 * The commands the project really has.
 *
 * The scripts of `package.json` come first; after them the usual commands of a Node.js
 * project, but only when the files for them exist.
 * @param {{ root: string, limit?: number }} options
 * @returns {Promise<{ commands: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function suggestCommands({ root, limit = MAX_SUGGESTIONS } = {}) {
    const base = path.resolve(String(root ?? process.cwd()));
    const commands = [];
    let pkg = null;
    try {
        const { abs } = await resolveInside(base, 'package.json', { allowRoot: false });
        pkg = parseJsonc(await readFile(abs, 'utf8'));
    } catch {
        pkg = null;
    }
    const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : {};
    for (const name of Object.keys(scripts)) {
        if (name === 'test') commands.push('npm test');
        else commands.push(`npm run ${name}`);
    }
    const tree = await listTree(base, { maxDepth: 3 });
    const has = (name) => tree.includes(name);
    if (has('package-lock.json') || has('pnpm-lock.yaml') || has('yarn.lock')) commands.push('npm ci');
    if (has('Dockerfile')) commands.push('docker build -t app .');
    if (has('tsconfig.json')) commands.push('npx tsc --noEmit');
    if (has('eslint.config.js') || has('.eslintrc.json')) commands.push('npx eslint .');
    return { commands: [...new Set(commands)].slice(0, Math.max(1, limit)) };
}

/**
 * The suggestions of the context: the paths, the commands, or both.
 * @param {{ root: string, prefix?: string, kind?: 'path'|'command'|'all', limit?: number }} options
 * @returns {Promise<{ kind: string, prefix: string, paths: string[], commands: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function suggest({ root, prefix = '', kind = 'all', limit = MAX_SUGGESTIONS } = {}) {
    const wantPaths = kind === 'path' || kind === 'all';
    const wantCommands = kind === 'command' || kind === 'all';
    const paths = wantPaths ? await suggestPaths({ root, prefix, limit }) : { paths: [] };
    const commands = wantCommands ? await suggestCommands({ root, limit }) : { commands: [] };
    return {
        kind,
        prefix: paths.prefix ?? String(prefix ?? '').trim().toLowerCase(),
        paths: paths.paths,
        commands: commands.commands,
    };
}
