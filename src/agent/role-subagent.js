/**
 * @file src/agent/role-subagent.js
 * @module agent/role-subagent
 * @purpose The hand-over of a role of the CLI to a sub-agent: a separate worker that runs
 *          an inherited role over the same project.
 *
 *   The agent of the CLI is a chain of roles — analyzer, director, executor — and every
 *   one of them meets work that is one bounded piece of another kind. A piece of that size
 *   does not belong in the conversation of the role: it eats the context of the model and
 *   buries the thread of the work.
 *
 *   The work goes to a **sub-agent**: a separate worker that starts with a clean
 *   conversation, its own instructions and its own budget of turns. The sub-agent carries
 *   no role of its own — everything it is comes from here: the **role** it inherits, the
 *   **goal** of the work, the **files** it may touch, and the **rights** it has inside the
 *   project. The sub-agent asks this process to run a tool, and this process runs it with
 *   its own executor and its own rules.
 *
 *   The big texts of the hand-over — the instructions of the role, the notes of the
 *   context — travel in **shared memory** when the transport is a thread: one buffer the
 *   parent writes and the thread reads, with the flag of cancellation inside it. A process
 *   gets the texts inside the spec — shared memory does not cross processes.
 *
 *   The bytes of the work travel as frames: a picture the sub-agent reads never goes
 *   through the disk.
 *
 * @depends agent/worker-runner, shared/house/shared, model/refs
 * @usedBy roles/index, server/agent
 * @exports ROLE_SUBAGENTS, ROLE_SUBAGENT_NAMES, roleSubagentToolNames, roleSubagentNote,
 *          createRoleSubagentSpawner
 * @ai.tags subagent, roles, server, threads, processes
 * @ai.hint io
 */

import { stat } from 'node:fs/promises';
import { runServerWorker } from './worker-runner.js';
import { createSharedBlock, sharedAvailable } from '../shared/house/shared.js';
import { resolveBackends } from '../openai/client.js';

/**
 * The roles a sub-agent of the CLI may inherit.
 *
 * The roles of the whole run — the analyzer, the director, the executor — are not here:
 * they work once, over the whole task, and a piece of that size is not a piece. The
 * inheritable roles are the bounded ones: a look, a plan, a hand.
 *
 * @type {Readonly<Record<string, Readonly<{ description: string, tools: string, maxTurns: number }>>>}
 * @exports
 */
export const ROLE_SUBAGENTS = Object.freeze({
    analyzer: {
        description: 'a look at a task against the project: what it is, the files it touches, the risks',
        tools: 'read',
        maxTurns: 6,
    },
    director: {
        description: 'a plan of a bounded piece of work: the steps, the files, the way to check them',
        tools: 'read',
        maxTurns: 6,
    },
    executor: {
        description: 'the hands of the server: the steps of a bounded piece of work, done with the tools',
        tools: 'all',
        maxTurns: 8,
    },
});

/** The names of the inheritable roles. @exports */
export const ROLE_SUBAGENT_NAMES = Object.freeze(Object.keys(ROLE_SUBAGENTS));

/**
 * The tools a sub-agent of one role may call.
 *
 * The tools come from the mode of the role (`read` or `all`), cut by the tools the
 * caller named as runnable: a tool this process cannot run is a tool the sub-agent
 * would call into the void.
 *
 * @param {string} name the role
 * @param {string[]} runnable the tools the executor of the parent really runs
 * @param {Function|null} [toolNamesFor] the mode of a role as a list of names
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function roleSubagentToolNames(name, runnable = [], toolNamesFor = null) {
    const key = String(name ?? '').trim().toLowerCase();
    const role = ROLE_SUBAGENTS[key];
    if (!role) return [];
    const own = typeof toolNamesFor === 'function' ? toolNamesFor(key) : [];
    const base = own.length ? own : (role.tools === 'all' ? [...runnable] : []);
    return base
        .filter((tool) => tool !== 'subagent')
        .filter((tool) => !runnable.length || runnable.includes(tool));
}

/**
 * The rule that tells a role when to hand the work over.
 * @param {string[]} names
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function roleSubagentNote(names = []) {
    const list = Array.isArray(names) ? names : [];
    if (!list.length) return '';
    const described = list
        .map((name) => `${name} — ${ROLE_SUBAGENTS[name]?.description ?? ''}`.trim())
        .join('\n');
    return [
        'When the work is one bounded piece of another kind, hand it over instead of doing it yourself:',
        described,
        'Name the role, the task and the reason. The sub-agent starts in a separate worker with a clean',
        'conversation: it does not see this conversation, so the task has to say everything it needs —',
        'the files, what is wrong and what the result has to be. Name every expected output file in the',
        '`files` field. The sub-agent inherits your tools and your rights: it works in the same project,',
        'and the files it writes are written by your tools. Wait for its report, check that its files',
        'were actually written, then continue with your own work.',
    ].join('\n');
}

/**
 * The text of a value.
 * @param {unknown} value
 * @returns {string}
 * @ai.hint pure
 */
function textOf(value) {
    return typeof value === 'string' ? value : '';
}

/**
 * The spawner of a sub-agent of the CLI.
 *
 * The spawner builds the spec of the sub-agent out of the role it inherits and the goal
 * of the work, starts the worker and waits for the report. The tools of the sub-agent are
 * the tools of this process: the sub-agent asks, this process runs — with its own
 * executor, its own rules and its own map of the run.
 *
 * @param {{ config?: object|null, root: string, env?: object, notify?: Function,
 *   depth?: number, executor?: Function|null, instructions?: string|null,
 *   toolNamesFor?: Function|null, model?: string|null, effort?: string|null,
 *   baseURL?: string|null, apiKey?: string|null, specs?: string[]|null,
 *   signal?: AbortSignal|null }} options
 *   `executor` runs a tool of the parent: `async (name, args) => text`. `instructions`
 *   are the instructions of the inherited role. `toolNamesFor` gives the tools of a role
 *   by its name. `specs` are the names of the tools the executor really runs.
 * @returns {(args: object) => Promise<string>}
 * @exports
 * @ai.hint io
 */
export function createRoleSubagentSpawner({
    config = {},
    root,
    env = process.env,
    notify = () => {},
    depth = 0,
    executor = null,
    instructions = null,
    toolNamesFor = null,
    model = null,
    effort = null,
    baseURL = null,
    apiKey = null,
    specs = null,
    signal = null,
} = {}) {
    return async function spawn(args = {}) {
        const name = String(args?.role ?? '').trim().toLowerCase();
        const task = String(args?.task ?? '').trim();
        const reason = String(args?.reason ?? '').trim();
        // The model, the effort and the key the caller named: they win over the ones of
        // the run. A sub-agent on another model is the choice of the caller, not a
        // surprise of the run.
        const askedModel = String(args?.model ?? '').trim();
        const askedEffort = String(args?.effort ?? '').trim();
        const askedKey = String(args?.apiKey ?? '').trim();
        const askedTransport = String(args?.transport ?? '').trim().toLowerCase() === 'process'
            ? 'process'
            : 'thread';
        const expected = [];
        for (const file of Array.isArray(args?.files) ? args.files : []) {
            const value = String(file ?? '').trim();
            if (!value) continue;
            if (!expected.some((item) => item.toLowerCase() === value.toLowerCase())) expected.push(value);
        }
        if (!name) throw new Error('subagent: name the role the sub-agent inherits.');
        if (!task) throw new Error('subagent: the task is empty — say what has to be done.');
        if (!ROLE_SUBAGENTS[name]) {
            throw new Error(`subagent: unknown role «${name}» (available: ${ROLE_SUBAGENT_NAMES.join(', ')}).`);
        }
        if (depth > 0) {
            throw new Error('subagent: a hand-over deeper than one level is not done.');
        }
        if (!expected.length) {
            throw new Error('subagent: name the concrete output files in the field files.');
        }

        const baseline = new Map();
        for (const file of expected) {
            try {
                const abs = `${root}/${file}`.replaceAll('\\', '/');
                const info = await stat(abs);
                if (info.isFile()) baseline.set(file.toLowerCase(), `${info.size}:${info.mtimeMs}`);
            } catch { /* A missing expected file is the usual case for a sub-agent. */ }
        }

        notify({ type: 'subagent.start', from: 'cli', to: name, task, reason });
        // The instructions of the inherited role: the sub-agent speaks them as they are.
        const inherited = textOf(instructions);
        // The API of the house: the sub-agent talks to the same API with the same key.
        const backends = resolveBackends(config ?? {}, { kind: 'text', model: askedModel || model, env });
        const backend = backends[0] ?? null;
        const modelOf = askedModel || model || '';
        const effortOf = askedEffort || effort || null;
        const keyOf = askedKey || apiKey || backend?.apiKey || '';
        const addressOf = baseURL || backend?.baseURL || '';
        // The tools of the sub-agent: the tools of the role it inherits, and among them
        // only the ones this process can really run.
        const runnable = Array.isArray(specs) ? specs.map(String) : [];
        const inheritedTools = roleSubagentToolNames(name, runnable, toolNamesFor);
        // The shared memory of the hand-over: the instructions and the notes travel in one
        // buffer when the thread transport can carry it. A process gets the texts inside
        // the spec — shared memory does not cross processes.
        const useShared = askedTransport === 'thread' && sharedAvailable();
        const shared = useShared
            ? createSharedBlock({ instructions: inherited, notes: '' })
            : null;
        const report = await runServerWorker({
            spec: {
                name: `${name}-${Date.now().toString(36)}`,
                role: {
                    name,
                    // In the thread transport the instructions live in the shared memory;
                    // the spec carries them too, for a reader that has no buffer.
                    instructions: shared ? '' : inherited,
                    tools: inheritedTools,
                },
                goal: task,
                reason,
                files: expected,
                budget: { maxTurns: Math.min(ROLE_SUBAGENTS[name].maxTurns ?? 8, 8) },
                model: {
                    model: modelOf,
                    baseURL: addressOf,
                    apiKey: keyOf,
                    effort: effortOf,
                },
                context: {
                    notes: shared ? '' : inherited,
                },
                // The buffer of the hand-over: the thread reads its texts from here.
                shared: shared?.buffer ?? null,
            },
            transport: askedTransport,
            signal,
            // The stop of the run travels into the shared memory: the thread sees the flag
            // between its turns, without a message round trip.
            onCancel: shared ? () => shared.cancel() : null,
            onEvent: (event) => {
                notify({ type: 'subagent.status', from: 'cli', to: name, event });
            },
            // The tools are the tools of this process: the sub-agent asks, this process runs.
            onCall: async (call) => {
                if (typeof executor !== 'function') {
                    throw new Error(`The tool ${call?.name} is not available here.`);
                }
                return await executor(call?.name, call?.arguments ?? {});
            },
        });

        // The files of the goal are checked on the disk: the disk keeps the truth.
        const existing = [];
        const expectedMissing = [];
        for (const file of expected) {
            try {
                const abs = `${root}/${file}`.replaceAll('\\', '/');
                const info = await stat(abs);
                if (!info.isFile()) {
                    expectedMissing.push(file);
                    continue;
                }
                const before = baseline.get(file.toLowerCase());
                if (before && `${info.size}:${info.mtimeMs}` === before) {
                    expectedMissing.push(`${file} (not changed)`);
                    continue;
                }
                existing.push(file);
            } catch {
                expectedMissing.push(file);
            }
        }
        const ok = report?.ok === true && existing.length > 0 && expectedMissing.length === 0;
        notify({
            type: 'subagent.done',
            from: 'cli',
            to: name,
            turns: report?.turns ?? 0,
            ok,
            files: existing,
        });

        const lines = [
            `The sub-agent of the role ${name} worked in a separate ${askedTransport}: ${report?.turns ?? 0} turns.`,
            ok ? 'The output of the sub-agent: VERIFIED.' : 'The output of the sub-agent: NOT VERIFIED; continue the work here or report the blocker.',
            existing.length ? `Verified files on disk: ${existing.join(', ')}` : 'No output files were verified on disk.',
            expectedMissing.length ? `Expected files still missing: ${expectedMissing.join(', ')}.` : '',
            report?.report ? String(report.report) : '(the sub-agent said nothing)',
        ];
        return lines.filter(Boolean).join('\n');
    };
}
