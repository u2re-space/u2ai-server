/**
 * @file src/server/agent.js
 * @module server/agent
 * @purpose The agent behind the bus: the runs that the clients start.
 *
 *   The bus carries the commands of the clients — `ask`, `run`, `chat`, `image` — and this
 *   module answers them. The agent knows three things:
 *
 *   1. the model is asked through the API client of the package;
 *   2. the tools of the model go through the hub, so a client that holds a tool runs it
 *      itself, and the server runs the tools that nobody holds;
 *   3. every step of the work is published to the bus as an event, so the editor sees
 *      the life of the run: the text of the answer, the tools, the warnings.
 *
 *   The pictures are not here: the package has no image generator, and the command `image`
 *   answers with a clear warning instead of a silent failure.
 *
 *   Every run leaves two traces in the house of the project: the state of the run in
 *   `.ai/tmp/<run-id>/` and the files it wrote in the contract `.ai/manifest.json`. A
 *   failure to sign them is a warning, never a crash.
 *
 *   The agent never throws at the bus: a failure is an event and a finished run.
 *
 * @depends openai/client, openai/responses, tools/tools, server/publish, agent/subagent
 * @usedBy cli, server/serve
 * @exports createServerAgent, AGENT_COMMANDS, AGENT_INSTRUCTIONS
 * @ai.tags agent, server, bus
 * @ai.hint io
 */

import { createClient } from '../openai/client.js';
import { parseResponse, textPart } from '../openai/responses.js';
import { TOOL_NAMES, TOOL_SPECS, toolAllowed, toolDefinitions } from '../tools/tools.js';
import { signRun } from './publish.js';
import { resolveModelRef } from '../model/refs.js';
import { buildSkillInstructions, discoverSkills, skillsDirectory } from '../agent/skills.js';
import { SERVER_SUBAGENT_NAMES, subagentNote, createSubagentSpawner } from '../agent/subagent.js';

/** The commands the agent of the bus answers. */
export const AGENT_COMMANDS = Object.freeze(['ask', 'run', 'chat']);

/** The words the model is given when the client asks a question. */
export const AGENT_INSTRUCTIONS = [
    'You are the assistant of a code editor. Answer in the language of the question.',
    'Be exact and short. Do not describe what you are about to do — do it.',
].join(' ');

/** The words the model is given when the client asks for the work. */
const RUN_INSTRUCTIONS = [
    'You are the agent of a code editor. Do the work the client asks for.',
    'Use the tools of the catalog: read before you write, and change one thing at a time.',
    'When the work is done, answer with a short report of what you changed.',
].join(' ');

/** The words of the chat: the model keeps the thread of the conversation. */
const CHAT_INSTRUCTIONS = [
    'You are the assistant of a code editor. You are in a chat: keep the thread of the conversation.',
    'Answer in the language of the question, and be exact.',
].join(' ');

/**
 * The tools the configuration allows.
 * @param {object|null} config
 * @returns {string[]}
 * @ai.hint pure
 */
function allowedTools(config) {
    return TOOL_NAMES.filter((name) => toolAllowed(name, config));
}

/**
 * The tools of one run: the catalog, cut by the frame of the client.
 *
 * A client may ask for a narrow list of the tools, or for none of them at all.
 *
 * @param {object|null} config
 * @param {object} frame
 * @returns {string[]}
 * @ai.hint pure
 */
function toolsOfRun(config, frame) {
    if (frame?.noTools === true) return [];
    const list = allowedTools(config);
    const wanted = Array.isArray(frame?.tools) ? frame.tools.map(String) : null;
    if (!wanted || !wanted.length) return list;
    const keep = new Set(wanted);
    return list.filter((name) => keep.has(name));
}

/**
 * Create the agent of the bus.
 *
 * The agent is the runner the hub calls: it gives the agent the run and the frame of the
 * client, and the agent answers with the events of the run.
 *
 * @param {{ hub: object, config?: object|null, root?: string, model?: string|null,
 *           approve?: string, client?: object|null, instructions?: string|null,
 *           onEvent?: Function|null }} options
 * @returns {{ start: (run: object, frame: object) => Promise<void> }}
 * @exports
 * @ai.hint io
 */
export function createServerAgent({
    hub,
    config = null,
    root = process.cwd(),
    model = null,
    approve = 'ask',
    client = null,
    instructions = null,
    onEvent = null,
} = {}) {
    if (!hub) throw new Error('The agent needs the hub of the bus.');
    let clientPromise = null;

    /**
     * The API client of the agent. It is made on the first run, so the server starts even
     * when the keys of the backends are not set yet.
     * @returns {Promise<object>}
     * @ai.hint io
     */
    const api = async () => {
        if (client) return client;
        if (!clientPromise) {
            clientPromise = createClient({ config, env: process.env }).catch((error) => {
                clientPromise = null;
                throw error;
            });
        }
        return clientPromise;
    };

    /**
     * Publish one event of a run.
     * @param {string} runId
     * @param {object} event
     * @returns {void}
     * @ai.hint pure
     */
    const publish = (runId, event) => {
        try {
            hub.publish(runId, event);
        } catch { /* the bus is gone */ }
        // The reader of the terminal sees the events of the runs too: the service is alive,
        // and the person at the terminal sees what it is doing.
        try {
            onEvent?.({ id: runId, ...event });
        } catch { /* an observer never breaks a run */ }
    };

    /**
     * The root of the tools of a run: the directory of the client, when it named one.
     * @param {object} run
     * @param {object} frame
     * @returns {string}
     * @ai.hint pure
     */
    const rootOf = (run, frame) => {
        const asked = typeof frame?.cwd === 'string' ? frame.cwd.trim() : '';
        const own = typeof run?.cwd === 'string' ? run.cwd.trim() : '';
        return asked || own || root;
    };

    /**
     * Forward the events of the model to the bus.
     * @param {object} run
     * @param {object} event
     * @returns {void}
     * @ai.hint pure
     */
    const forward = (run, event) => {
        const type = event?.type;
        if (type === 'text.delta') {
            publish(run.id, { type: 'text.delta', text: String(event.text ?? '') });
            return;
        }
        if (type === 'reasoning.delta') {
            publish(run.id, { type: 'reasoning.delta', text: String(event.text ?? '') });
        }
    };

    /**
     * The spawner of a sub-agent of one run.
     *
     * The tools of the sub-agent are the tools of this server: the sub-agent asks, and
     * the call goes through the same `runTool` — the holder of the tool runs it, the
     * approval is asked the same way, and the events land in the same run. The life of
     * the sub-agent is published to the bus as the events of the run: the editor sees
     * the hand-over as it sees a tool.
     *
     * @param {object} run
     * @param {object} frame
     * @param {string[]} tools the tools of the run
     * @param {string} system the instructions of the run
     * @returns {(args: object) => Promise<string>}
     * @ai.hint io
     */
    const subagentSpawner = (run, frame, tools, system) => createSubagentSpawner({
        config,
        root: rootOf(run, frame),
        depth: 0,
        notify: (event) => publish(run.id, event),
        // The executor of this server: the same road the tools of the run take.
        executor: async (name, args) => {
            const result = await runTool(run, frame, name, args, run?.controller?.signal ?? null);
            if (!result.ok) throw new Error(result.error ?? 'The tool failed.');
            return result.output;
        },
        // The instructions of the inherited role: the words of the run, plus the note
        // that the sub-agent works alone.
        instructions: [
            system,
            'You work alone in a separate worker: you do not see the conversation of the run.',
            'Do the bounded work the goal names, write the files it names, and report what you did.',
        ].filter(Boolean).join('\n\n'),
        // The tools of a role of the server: the mode of the role, cut by the run.
        toolNamesFor: (role) => tools.filter((tool) => tool !== 'subagent'),
        // The tools the executor really runs: the tools of the run.
        specs: tools,
        model,
        effort: config?.reasoning?.effort ?? null,
        baseURL: config?.baseURL ?? null,
        apiKey: config?.apiKey ?? null,
        signal: run?.controller?.signal ?? null,
    });

    /**
     * Run one tool of the model: the holder of the tool runs it, or the server does.
     * @param {object} run
     * @param {object} frame
     * @param {string} name
     * @param {object} args
     * @param {AbortSignal|null} signal
     * @param {object[]|null} [sink] where the changes of the tool are collected
     * @returns {Promise<{ ok: boolean, output: string, summary: string, changes: object[], error: string|null }>}
     * @ai.hint io
     */
    const runTool = async (run, frame, name, args, signal, sink = null) => {
        publish(run.id, {
            type: 'tool.exec.start',
            name,
            category: TOOL_SPECS[name]?.category ?? null,
            risk: TOOL_SPECS[name]?.risk ?? null,
        });
        let answer;
        try {
            answer = await hub.runTool(run.id, name, args, {
                root: rootOf(run, frame),
                config,
                signal,
                approve: frame?.approve ?? approve,
            });
        } catch (error) {
            answer = {
                ok: false,
                output: '',
                summary: '',
                changes: [],
                error: error?.message ?? String(error),
            };
        }
        publish(run.id, {
            type: 'tool.exec.done',
            name,
            ok: Boolean(answer?.ok),
            summary: answer?.summary || (answer?.ok ? 'done' : 'failed'),
            changes: Array.isArray(answer?.changes) ? answer.changes : [],
            error: answer?.error ?? null,
        });
        if (sink && Array.isArray(answer?.changes)) sink.push(...answer.changes);
        return {
            ok: Boolean(answer?.ok),
            output: typeof answer?.output === 'string' ? answer.output : '',
            summary: typeof answer?.summary === 'string' ? answer.summary : '',
            changes: Array.isArray(answer?.changes) ? answer.changes : [],
            error: answer?.error ?? null,
        };
    };

    /**
     * Ask the model once and return the answer.
     * @param {object} run
     * @param {{ input: object[], tools: string[], system: string, signal: AbortSignal|null }} options
     * @returns {Promise<object>} the parsed answer of the model
     * @ai.hint io
     */
    const ask = async (run, { input, tools, system, signal }) => {
        const client = await api();
        const raw = await client.responses.create({
            model: resolveModelRef(model ?? config?.model ?? null, config, { effort: config?.reasoning?.effort ?? null }),
            instructions: system,
            input,
            tools: tools.length ? toolDefinitions(tools) : null,
            effort: config?.reasoning?.effort ?? null,
            summary: config?.reasoning?.summary ?? null,
            stream: true,
            signal,
            onEvent: (event) => forward(run, event),
        });
        return parseResponse(raw, { schemaName: null });
    };

    /**
     * The work of a turn: the model asks for the tools until it has the answer.
     * @param {object} run
     * @param {{ input: object[], tools: string[], system: string, signal: AbortSignal|null,
     *           maxTurns: number, changes?: object[]|null }} options
     * @returns {Promise<{ text: string, turns: number, limitReached: boolean }>}
     * @ai.hint io
     */
    const complete = async (run, frame, { input, tools, system, signal, maxTurns, changes = null }) => {
        let text = '';
        for (let turn = 1; turn <= maxTurns; turn += 1) {
            const answer = await ask(run, { input, tools, system, signal });
            if (answer.text) text = answer.text;
            const calls = Array.isArray(answer.toolCalls) ? answer.toolCalls : [];
            if (!calls.length) {
                publish(run.id, { type: 'text.done', text });
                publish(run.id, {
                    type: 'response.done',
                    usage: answer.usage ?? null,
                    model: answer.model ?? null,
                });
                return { text, turns: turn, limitReached: false };
            }
            for (const call of calls) {
                // The hand-over to a sub-agent: the tool of the catalog says what has to
                // happen, and the spawner of this run does it. The report of the sub-agent
                // goes back to the model as the output of the call.
                if (call.name === 'subagent') {
                    const report = await subagentSpawner(run, frame, tools, system)(call.arguments ?? {});
                    const id = call.callId ?? call.id ?? null;
                    input.push({
                        type: 'function_call',
                        call_id: id,
                        name: call.name,
                        arguments: call.raw ?? JSON.stringify(call.arguments ?? {}),
                    });
                    input.push({ type: 'function_call_output', call_id: id, output: report });
                    continue;
                }
                const result = await runTool(run, frame, call.name, call.arguments ?? {}, signal, changes);
                const id = call.callId ?? call.id ?? null;
                input.push({
                    type: 'function_call',
                    call_id: id,
                    name: call.name,
                    arguments: call.raw ?? JSON.stringify(call.arguments ?? {}),
                });
                input.push({
                    type: 'function_call_output',
                    call_id: id,
                    output: result.ok ? result.output : `The tool failed: ${result.error ?? 'unknown error'}`,
                });
            }
        }
        publish(run.id, { type: 'text.done', text });
        publish(run.id, { type: 'warning', message: `The limit of the turns is reached: ${maxTurns}.` });
        return { text, turns: maxTurns, limitReached: true };
    };

    /**
     * The chat of a run: the line of the client, then the answer of the model, again and
     * again. The prompt of the client is the first line of the chat.
     * @param {object} run
     * @param {{ tools: string[], system: string, signal: AbortSignal|null, maxTurns: number,
     *           changes?: object[]|null }} options
     * @returns {Promise<void>}
     * @ai.hint io
     */
    const chat = async (run, frame, { tools, system, signal, maxTurns, changes = null }) => {
        const input = [];
        for (;;) {
            const line = await hub.waitInput(run.id, signal);
            if (typeof line !== 'string') return;
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (/^\/(?:exit|quit|stop)$/i.test(trimmed)) return;
            input.push({ role: 'user', content: [textPart(trimmed)] });
            const answer = await complete(run, frame, { input, tools, system, signal, maxTurns, changes });
            if (answer.text) input.push({ role: 'assistant', content: [textPart(answer.text)] });
        }
    };

    /**
     * Sign the run: the state of the run in the house of the project and the files it wrote
     * in the contract of the project.
     *
     * A failure is a warning: the work of the run is already done, and the contract is a
     * hint for the other systems of the house.
     * @param {object} run
     * @param {object} frame
     * @param {object[]} changes
     * @param {string} status
     * @param {string} command
     * @returns {Promise<void>}
     * @ai.hint io
     */
    const sign = async (run, frame, changes, status, command) => {
        const answer = await signRun(rootOf(run, frame), run?.id ?? '', {
            changes,
            state: {
                command,
                status,
                startedAt: run?.startedAt ?? null,
                finishedAt: new Date().toISOString(),
            },
        });
        if (!answer.ok) {
            publish(run.id, {
                type: 'warning',
                message: `The contract of the project is not signed: ${answer.error}`,
            });
        }
    };

    /**
     * The run of a client: the command is answered, the events are published, and the run
     * is finished. A failure is an event, never an exception.
     * @param {object} run
     * @param {object} frame
     * @returns {Promise<void>}
     * @ai.hint io
     */
    const start = async (run, frame) => {
        const command = String(frame?.command ?? 'ask');
        const signal = run?.controller?.signal ?? null;
        const tools = command === 'ask' ? [] : toolsOfRun(config, frame);
        const baseSystem = instructions ?? (
            command === 'run' ? RUN_INSTRUCTIONS : command === 'chat' ? CHAT_INSTRUCTIONS : AGENT_INSTRUCTIONS
        );
        const skillDir = skillsDirectory(config);
        const availableSkills = tools.includes('read_skill')
            ? await discoverSkills(rootOf(run, frame), {
                extraDirs: skillDir ? [skillDir] : [],
            })
            : [];
        const skillCatalogue = buildSkillInstructions(availableSkills);
        // The rule of the hand-over: when the run may hand work to a sub-agent, the model
        // is told when to do it.
        const handOver = tools.includes('subagent') ? subagentNote(SERVER_SUBAGENT_NAMES) : '';
        const system = [baseSystem, skillCatalogue, handOver].filter(Boolean).join('\n\n');
        const maxTurns = Number.isSafeInteger(frame?.maxTurns) && frame.maxTurns > 0
            ? frame.maxTurns
            : (config?.limits?.maxTurns ?? 24);
        const changes = [];
        let status = 'failed';
        try {
            if (command === 'image') {
                publish(run.id, {
                    type: 'warning',
                    message: 'The server of this package does not generate pictures. Use the `ai-image` package.',
                });
                hub.finish(run.id, 'failed', 1);
                return;
            }
            if (!AGENT_COMMANDS.includes(command)) {
                publish(run.id, { type: 'error', message: `The command ${command} is not known.` });
                hub.finish(run.id, 'failed', 1);
                return;
            }
            if (command === 'chat') {
                await chat(run, frame, { tools, system, signal, maxTurns, changes });
            } else {
                const prompt = typeof frame?.prompt === 'string' ? frame.prompt : '';
                const input = [{ role: 'user', content: [textPart(prompt)] }];
                await complete(run, frame, { input, tools, system, signal, maxTurns, changes });
            }
            status = 'completed';
            hub.finish(run.id, 'completed', 0);
        } catch (error) {
            if (signal?.aborted) {
                status = 'cancelled';
                hub.finish(run.id, 'cancelled', 130);
                return;
            }
            publish(run.id, { type: 'error', message: error?.message ?? String(error) });
            hub.finish(run.id, 'failed', 1);
        } finally {
            await sign(run, frame, changes, status, command);
        }
    };

    return { start };
}
