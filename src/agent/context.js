/**
 * @file src/agent/context.js
 * @module agent/context
 * @purpose Collect the context of one role: the files of the workspace, the AGENTS.md of
 *          the project, and the files the task mentions.
 *
 *   A role that starts with an empty head writes code for a project it has not seen. This
 *   module gathers what the role needs to see before the first request:
 *
 *   - the card of the workspace (`tools/context`): the kind of the project, the aliases of
 *     the imports, the entry points, and the files the task mentions;
 *   - the `AGENTS.md` of the project: the rules the project writes for the agents;
 *   - the mentions of the form `@src/index.js` or `@src/index.js#10-40`, with the lines
 *     the task points at.
 *
 *   Every path goes through `agent/access`, so the context never leaves the root of the
 *   run and never opens a secret.
 *
 * @depends node:path, node:fs/promises, agent/access, tools/context, shared/format
 * @usedBy agent/roles, tools/tools, server/mcp
 * @exports AGENT_FILE_NAMES, parseMention, collectMentions, discoverAgents,
 *          collectRoleContext, formatRoleContext
 * @ai.tags context, agents, discovery
 * @ai.hint io
 * @ai.hint legacy-0.2
 */

import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { resolveInside } from './access.js';
import { scanWorkspace, formatWorkspace } from '../tools/context.js';
import { clipMiddle } from '../shared/format.js';

/** The names of the rules of a project, in the order of the search. */
export const AGENT_FILE_NAMES = Object.freeze(['AGENTS.md', 'agents.md']);

/** The largest rules file that goes into the context as a whole. */
const AGENTS_CAP = 16 * 1024;

/** The largest number of rules files the context holds. */
const AGENTS_FILE_CAP = 8;

/**
 * One mention of a file: `@src/index.js` or `@src/index.js#10-40`.
 * @param {string} value the mention, with or without the `@`
 * @returns {{ path: string, start: number|null, end: number|null }|null}
 * @exports
 * @ai.hint pure
 */
export function parseMention(value) {
    if (typeof value !== 'string') return null;
    const raw = value.startsWith('@') ? value.slice(1) : value;
    if (!raw || raw.includes('://') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return null;
    const match = /^((?:[\w.+-]+\/)*[\w.+-]+\.[\w.+-]+)(?:#(\d+)-(\d+))?$/.exec(raw);
    if (!match) return null;
    if (match[1].split('/').includes('..')) return null;
    if (match[2] == null) return { path: match[1], start: null, end: null };
    const start = Number(match[2]);
    const end = Number(match[3]);
    if (start < 1 || end < start) return null;
    return { path: match[1], start, end };
}

/**
 * The mentions of a text.
 * @param {string} text
 * @returns {{ path: string, start: number|null, end: number|null }[]}
 * @exports
 * @ai.hint pure
 */
export function collectMentions(text) {
    const found = [];
    const seen = new Set();
    const source = String(text ?? '');
    for (const match of source.matchAll(/@((?:[\w.+-]+\/)*[\w.+-]+\.[\w.+-]+(?:#\d+-\d+)?)/g)) {
        const mention = parseMention(match[1]);
        if (!mention) continue;
        const key = `${mention.path}:${mention.start ?? ''}-${mention.end ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push(mention);
    }
    return found;
}

/**
 * Read one rules file.
 * @param {string} file the absolute path
 * @returns {Promise<{ text: string, bytes: number }|null>}
 * @ai.hint io
 */
async function readRules(file) {
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return null;
    try {
        const buffer = await readFile(file);
        const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
        return { text, bytes: info.size };
    } catch {
        return null;
    }
}

/**
 * The rules of the project: the `AGENTS.md` of the directory and of every parent of it,
 * plus the global one of the home directory.
 *
 * The nearest file wins: the text of the deeper directory comes first.
 * @param {{ cwd?: string, home?: string|null, maxBytes?: number }} [options]
 * @returns {Promise<{ files: { path: string, text: string, bytes: number }[], text: string }>}
 * @exports
 * @ai.hint io
 */
export async function discoverAgents({ cwd = process.cwd(), home = null, maxBytes = AGENTS_CAP } = {}) {
    const files = [];
    const seen = new Set();
    let directory = path.resolve(String(cwd));
    for (;;) {
        for (const name of AGENT_FILE_NAMES) {
            const file = path.join(directory, name);
            if (seen.has(file)) continue;
            seen.add(file);
            const read = await readRules(file);
            if (read) files.push({ path: file, text: read.text, bytes: read.bytes });
        }
        if (files.length >= AGENTS_FILE_CAP) break;
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
    }
    if (home) {
        const file = path.join(String(home), AGENT_FILE_NAMES[0]);
        if (!seen.has(file)) {
            const read = await readRules(file);
            if (read) files.push({ path: file, text: read.text, bytes: read.bytes });
        }
    }
    const text = files
        .map((item) => `--- ${item.path} ---\n${clipMiddle(item.text, maxBytes)}`)
        .join('\n\n');
    return { files, text };
}

/**
 * Whether the file of a mention exists inside the root.
 * @param {string} root
 * @param {string} rel
 * @returns {Promise<boolean>}
 * @ai.hint io
 */
async function existsInside(root, rel) {
    try {
        const { abs } = await resolveInside(root, rel, { allowRoot: false });
        const info = await stat(abs).catch(() => null);
        return Boolean(info?.isFile());
    } catch {
        return false;
    }
}

/**
 * The prompt block of the context of a role.
 * @param {object} context the answer of `collectRoleContext`
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function formatRoleContext(context) {
    if (!context) return '';
    const lines = [];
    if (context.agentsText) lines.push(context.agentsText);
    if (context.workspaceText) lines.push(context.workspaceText);
    if (context.mentions?.length) {
        lines.push('', 'Mentions:');
        for (const mention of context.mentions) {
            const range = mention.start == null ? '' : ` (lines ${mention.start}-${mention.end})`;
            lines.push(`- ${mention.path}${range}`);
        }
    }
    return lines.join('\n');
}

/**
 * Collect the context of one role.
 *
 * @param {{ root: string, task?: string, role?: string, home?: string|null }} options
 * @returns {Promise<{ role: string, card: object|null, workspaceText: string,
 *           agents: object[], agentsText: string, mentions: object[], files: object[],
 *           text: string }>}
 * @exports
 * @ai.hint io
 */
export async function collectRoleContext({ root, task = '', role = 'agent', home = null } = {}) {
    const base = path.resolve(String(root ?? process.cwd()));
    const card = await scanWorkspace(base, { task });
    const agents = await discoverAgents({ cwd: base, home });
    const mentions = [];
    for (const mention of collectMentions(task)) {
        if (!(await existsInside(base, mention.path))) continue;
        mentions.push(mention);
    }
    const files = [...(card?.files ?? [])];
    for (const mention of mentions) {
        if (files.some((file) => file.path === mention.path)) continue;
        files.push({ path: mention.path, role: 'read', reason: 'mentioned in the task' });
    }
    const workspaceText = formatWorkspace(card);
    const context = {
        role,
        card,
        workspaceText,
        agents: agents.files,
        agentsText: agents.text,
        mentions,
        files,
    };
    context.text = formatRoleContext(context);
    return context;
}
