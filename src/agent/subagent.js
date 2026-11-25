/**
 * @file src/agent/subagent.js
 * @module agent/subagent
 * @purpose Handing work to a sub-agent: a separate worker — a thread or a process — that
 *          runs an inherited role over the shared project.
 *
 *   The server has roles of its own (analyzer, director, executor, tooler, suggester) and
 *   two agents that speak to the model: the agent of the CLI (`roles/index`) and the agent
 *   of the bus (`server/agent`). Both meet work that is one bounded piece of another kind —
 *   a wide search, a scan of many files, a second opinion on a plan — and a piece of that
 *   size does not belong in the conversation of the run: it eats the context of the model
 *   and buries the thread of the work.
 *
 *   The work goes to a **sub-agent**: a separate worker that starts with a clean
 *   conversation, its own budget of turns and the role it inherits. The sub-agent carries
 *   no role of its own — everything it is comes from here. What it shares with the server
 *   is the project: the working directory, the skills and the tools. The tools are the
 *   tools of the server: the sub-agent asks, the server runs — through the same hub, with
 *   the same approval, so a client that holds a tool runs it for the sub-agent too.
 *
 *   The data of the API call are **inherited**: the sub-agent talks to the same endpoint
 *   with the same key and the model of the run. The caller may name another model, another
 *   effort or another key — a named one wins over the run.
 *
 *   The big texts of the hand-over — the instructions of the role, the notes of the
 *   context — travel in **shared memory** when the transport is a thread: one buffer the
 *   parent writes and the thread reads, with the flag of cancellation inside it. A process
 *   gets the texts inside the spec — shared memory does not cross processes.
 *
 * @depends @u2ai/subagent, @u2ai/subagent/shared, openai/client
 * @usedBy server/agent, roles/index
 * @exports SERVER_SUBAGENTS, SERVER_SUBAGENT_NAMES, subagentToolNames, subagentNote,
 *          createSubagentSpawner
 * @ai.tags subagent, server, threads, processes
 * @ai.hint io
 */

import { stat } from 'node:fs/promises';
import { runSubAgent } from '@u2ai/subagent';
import { createSharedBlock, sharedAvailable } from '@u2ai/subagent/shared';
import { resolveBackends } from '../openai/client.js';

/**
 * The roles a sub-agent of the server may inherit.
 *
 * The roles of the whole run — the agent of the bus, the agent of the CLI — are not
 * here: they work once, over the whole task, and a piece of that size is not a piece.
 * The inheritable roles are the bounded ones: a look, a plan, a hand.
 *
 * @type {Readonly<Record<string, Readonly<{ description: string, tools: string, maxTurns: number }>>>}
 * @exports
 */
export const SERVER_SUBAGENTS = Object.freeze({
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
export const SERVER_SUBAGENT_NAMES = Object.freeze(Object.keys(SERVER_SUBAGENTS));

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
export function subagentToolNames(name, runnable = [], toolNamesFor = null) {
    const key = String(name ?? '').trim().toLowerCase();
    const role = SERVER_SUBAGENTS[key];
    if (!role) return [];
    const own = typeof toolNamesFor === 'function' ? toolNamesFor(key) : [];
    const base = own.length ? own : (role.tools === 'all' ? [...runnable] : []);
    return base
        .filter((tool) => tool !== 'subagent')
        .filter((tool) => !runnable.length || runnable.includes(tool));
}

/**
 * The rule that tells an agent when to hand the work over.
 * @param {string[]} names
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function subagentNote(names = []) {
    const list = Array.isArray(names) ? names : [];
    if (!list.length) return '';
    const described = list
        .map((name) => `${name} — ${SERVER_SUBAGENTS[name]?.description ?? ''}`.trim())
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
 * The spawner of a sub-agent of the server.
 *
 * The spawner builds the spec of the sub-agent out of the role it inherits and the goal
 * of the work, starts the worker and waits for the report. The tools of the sub-agent
 * are the tools of this server: the sub-agent asks, the server runs — the caller hands
 * the executor in, and the executor is the one the run already uses (the hub, with its
 * approval and its clients that hold tools).
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
export function createSubagentSpawner({
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
        if (!name) throw new Error('subagent: назовите роль, которую наследует суб-агент.');
        if (!task) throw new Error('subagent: задача пуста — напишите, что именно нужно сделать.');
        if (!SERVER_SUBAGENTS[name]) {
            throw new Error(`subagent: неизвестная роль «${name}» (доступны: ${SERVER_SUBAGENT_NAMES.join(', ')}).`);
        }
        if (depth > 0) {
            throw new Error('subagent: передача работы глубже одного уровня не делается.');
        }
        if (!expected.length) {
            throw new Error('subagent: укажите конкретные выходные файлы в поле files.');
        }

        const baseline = new Map();
        for (const file of expected) {
            try {
                const abs = `${root}/${file}`.replaceAll('\\', '/');
                const info = await stat(abs);
                if (info.isFile()) baseline.set(file.toLowerCase(), `${info.size}:${info.mtimeMs}`);
            } catch { /* A missing expected file is the usual case for a sub-agent. */ }
        }

        notify({ type: 'subagent.start', from: 'server', to: name, task, reason });
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
        // only the ones this server can really run.
        const runnable = Array.isArray(specs) ? specs.map(String) : [];
        const inheritedTools = subagentToolNames(name, runnable, toolNamesFor);
        // The shared memory of the hand-over: the instructions and the notes travel in one
        // buffer when the thread transport can carry it. A process gets the texts inside
        // the spec — shared memory does not cross processes.
        const useShared = askedTransport === 'thread' && sharedAvailable();
        const shared = useShared
            ? createSharedBlock({ instructions: inherited, notes: '' })
            : null;
        const report = await runSubAgent({
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
                rights: { cwd: root, write: true },
                budget: { maxTurns: Math.min(SERVER_SUBAGENTS[name].maxTurns ?? 8, 8) },
                // The gate of the write belongs to the agent of the `@u2ai/subagent`:
                // the sub-agent would have to open it before it writes. The roles of the
                // server know nothing of that gate, so it is closed here: the sub-agent
                // writes the files of its goal in the turn it is asked for them.
                output: { writeGate: false },
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
                notify({ type: 'subagent.status', from: 'server', to: name, event });
            },
            // The tools are the tools of this server: the sub-agent asks, the server runs.
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
                    expectedMissing.push(`${file} (не изменён)`);
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
            from: 'server',
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
