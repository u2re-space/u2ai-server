/**
 * @file src/roles/index.js
 * @module roles/index
 * @purpose The roles of the server and the loop that runs them.
 *
 *   A role is a request to the model with a schema of the answer, a set of tools and a
 *   limit of the turns. The loop of the role lives here:
 *
 *   1. the model is asked with the prompt of the role and the tools of the role;
 *   2. when the model asks for a tool, the tool runs and its answer goes back to the
 *      model as the output of the call;
 *   3. when the model submits the schema of the role, the role is done.
 *
 *   The loop stops at the limit of the turns (`limits.maxTurns`), so a model that keeps
 *   asking for tools does not run forever.
 *
 * @depends openai/responses, tools/tools, agent/context, roles/analyzer, roles/director,
 *          roles/executor, roles/tooler, roles/suggester
 * @usedBy cli, server/u2ai
 * @exports ROLE_NAMES, ROLE_PROMPTS, ROLE_TOOLS, resolveRoleSettings, roleToolNames,
 *          createRoleAsk, runRole, runAgent
 * @ai.tags roles, agent
 * @ai.hint io
 */

import { parseResponse, textPart } from '../openai/responses.js';
import { toolDefinitions, toolCategory } from '../tools/tools.js';
import { collectRoleContext } from '../agent/context.js';
import { analyzeTask } from './analyzer.js';
import { planWork } from './director.js';
import { executePlan } from './executor.js';
import { chooseTool, callTool, allowedToolNames, runTooler } from './tooler.js';
import { suggestAnswer } from './suggester.js';

/** The roles of the package. */
export const ROLE_NAMES = Object.freeze(['analyzer', 'director', 'executor', 'tooler', 'suggester']);

/** The instructions of the roles: the system prompt of each of them. */
export const ROLE_PROMPTS = Object.freeze({
    analyzer: 'You are an analyzer. You read a task against a project and name what the task is, the files it touches, the risks of the work, and the questions that block it. You never change anything.',
    director: 'You are a director. You turn a task into a plan of the work: the steps, the files of every step, and the way to check that a step is done. You never change anything.',
    executor: 'You are an executor. You do the steps of the plan with the tools of the catalog. You read before you write, and you report the result of every step.',
    tooler: 'You are a tooler. You choose the one tool of the catalog that fits the task and name its arguments. You never call the tools yourself.',
    suggester: 'You are a suggester. You answer the question of the user about the project and name the paths and the commands that help. You never change anything.',
});

/**
 * The tools of every role: `read` is the reading part of the catalog, `all` is the whole
 * catalog, `none` is no tool at all.
 */
export const ROLE_TOOLS = Object.freeze({
    analyzer: 'read',
    director: 'read',
    executor: 'all',
    tooler: 'none',
    suggester: 'read',
});

/** The levels of the reasoning effort, from the smallest to the largest. */
const EFFORT_LEVELS = Object.freeze(['minimal', 'low', 'medium', 'high']);

/**
 * The effort of the role, capped by `maxEffort`.
 * @param {string|null} effort
 * @param {string|null} maxEffort
 * @returns {string|null}
 * @ai.hint pure
 */
function clampEffort(effort, maxEffort) {
    if (!effort || !maxEffort) return effort ?? null;
    const level = EFFORT_LEVELS.indexOf(effort);
    const cap = EFFORT_LEVELS.indexOf(maxEffort);
    if (level < 0 || cap < 0) return effort;
    return level > cap ? maxEffort : effort;
}

/**
 * The settings of one role.
 *
 * The chain is the role, then `roles.default`, then the top level of the configuration:
 * the role wins, the default of the roles is the middle, and the top level is the last.
 *
 * @param {object|null} config
 * @param {string} role
 * @returns {{ model: string|null, effort: string|null, summary: string|null, temperature: number|null,
 *            maxOutputTokens: number|null, instructions: string|null, tools: string[]|null,
 *            context: boolean, maxTurns: number }}
 * @exports
 * @ai.hint pure
 */
export function resolveRoleSettings(config = null, role = 'agent') {
    const roles = config?.roles && typeof config.roles === 'object' ? config.roles : {};
    const own = roles[role] && typeof roles[role] === 'object' ? roles[role] : {};
    const fallback = roles.default && typeof roles.default === 'object' ? roles.default : {};
    /**
     * @param {string} key
     * @returns {unknown}
     * @ai.hint pure
     */
    const pick = (key) => {
        if (own[key] !== undefined && own[key] !== null) return own[key];
        if (fallback[key] !== undefined && fallback[key] !== null) return fallback[key];
        return null;
    };
    const maxTurns = config?.limits?.maxTurns;
    return {
        model: pick('model') ?? config?.model ?? null,
        effort: clampEffort(pick('effort') ?? config?.reasoning?.effort ?? null, pick('maxEffort')),
        summary: pick('summary') ?? config?.reasoning?.summary ?? null,
        temperature: typeof pick('temperature') === 'number' ? pick('temperature') : null,
        maxOutputTokens: Number.isSafeInteger(pick('maxOutputTokens')) ? pick('maxOutputTokens') : null,
        instructions: typeof pick('instructions') === 'string' ? pick('instructions') : null,
        tools: Array.isArray(pick('tools')) ? pick('tools').map(String) : null,
        context: pick('context') !== false,
        maxTurns: Number.isSafeInteger(maxTurns) && maxTurns > 0 ? maxTurns : 24,
    };
}

/**
 * The names of the tools of one role.
 *
 * The configuration decides which tools exist at all, and the role decides which of them
 * the model may call: `roles.<name>.tools` narrows the list.
 *
 * @param {object|null} config
 * @param {string} role
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function roleToolNames(config = null, role = 'agent') {
    const settings = resolveRoleSettings(config, role);
    const mode = ROLE_TOOLS[role] ?? 'read';
    const allowed = allowedToolNames(config);
    const list = mode === 'none'
        ? []
        : mode === 'all'
            ? allowed
            : allowed.filter((name) => toolCategory(name) === 'read');
    if (!settings.tools) return list;
    const limit = new Set(settings.tools);
    return list.filter((name) => limit.has(name));
}

/**
 * Create the loop of a role: the function that asks the model and runs the tools.
 *
 * @param {{ client: object, config?: object|null, root: string, tools?: string[],
 *           model?: string|null, effort?: string|null, summary?: string|null,
 *           temperature?: number|null, maxOutputTokens?: number|null, instructions?: string|null,
 *           maxTurns?: number|null, signal?: AbortSignal|null, onEvent?: Function|null }} options
 * @returns {(request: object) => Promise<object>}
 * @exports
 * @ai.hint io
 */
export function createRoleAsk({
    client,
    config = null,
    root,
    tools = [],
    model = null,
    effort = null,
    summary = null,
    temperature = null,
    maxOutputTokens = null,
    instructions = null,
    maxTurns = null,
    signal = null,
    onEvent = null,
} = {}) {
    if (!client?.responses?.create) throw new Error('The role needs an API client.');
    const limit = Number.isSafeInteger(maxTurns) && maxTurns > 0 ? maxTurns : 24;
    const definitions = toolDefinitions(tools);

    /**
     * One request of the role: the model, the tools, the schema.
     * @param {{ prompt: string, schema?: object|null, schemaName?: string, strict?: boolean }} request
     * @returns {Promise<{ text: string, data: object|null, toolCalls: object[], turns: number,
     *           usage: object|null, limitReached: boolean, raw: object|null }>}
     * @ai.hint io
     */
    return async function ask({ prompt, schema = null, schemaName = 'response', strict = true } = {}) {
        const input = [{ role: 'user', content: [textPart(String(prompt ?? ''))] }];
        const calls = [];
        for (let turn = 1; turn <= limit; turn += 1) {
            const raw = await client.responses.create({
                model,
                instructions,
                input,
                tools: definitions,
                schema,
                schemaName,
                schemaChannel: 'auto',
                strict,
                effort,
                summary,
                temperature,
                maxOutputTokens,
                signal,
                onEvent,
            });
            const parsed = parseResponse(raw, { schemaName });
            const toolCalls = parsed.toolCalls ?? [];
            const realCalls = toolCalls.filter((call) => call.name !== schemaName);
            if (!realCalls.length) {
                return {
                    text: parsed.text,
                    data: parsed.data,
                    toolCalls: calls,
                    turns: turn,
                    usage: parsed.usage,
                    limitReached: false,
                    raw,
                };
            }
            for (const call of realCalls) {
                const result = await callTool(call.name, call.arguments, { root, config, signal });
                calls.push({ name: call.name, arguments: call.arguments, ok: result.ok, text: result.text });
                const id = call.callId ?? call.id ?? null;
                input.push({ type: 'function_call', call_id: id, name: call.name, arguments: call.raw ?? JSON.stringify(call.arguments ?? {}) });
                input.push({ type: 'function_call_output', call_id: id, output: result.text });
            }
        }
        return {
            text: '',
            data: null,
            toolCalls: calls,
            turns: limit,
            usage: null,
            limitReached: true,
            raw: null,
        };
    };
}

/**
 * Run one role.
 *
 * @param {string} role the name of the role
 * @param {{ task?: string, analysis?: object|null, plan?: object|null, context?: object|null,
 *           config?: object|null, client: object, root: string, env?: object, signal?: AbortSignal|null,
 *           onEvent?: Function|null, maxTurns?: number|null, model?: string|null }} options
 * @returns {Promise<object>} the answer of the role
 * @exports
 * @ai.hint io
 */
export async function runRole(role, {
    task = '',
    analysis = null,
    plan = null,
    context = null,
    config = null,
    client,
    root,
    signal = null,
    onEvent = null,
    maxTurns = null,
    model = null,
} = {}) {
    if (!ROLE_NAMES.includes(role)) throw new Error(`There is no role named ${role}.`);
    if (!client) throw new Error('The role needs an API client.');
    const settings = resolveRoleSettings(config, role);
    let contextText = context?.text ?? null;
    if (contextText === null && settings.context) {
        const collected = await collectRoleContext({
            root,
            task,
            role,
            home: config?.home ?? null,
        });
        contextText = collected.text;
    }
    const catalog = roleToolNames(config, role);
    const directTools = ROLE_TOOLS[role] === 'none' ? [] : catalog;
    const instructions = settings.instructions
        ? `${ROLE_PROMPTS[role]}\n\n${settings.instructions}`
        : ROLE_PROMPTS[role];
    const ask = createRoleAsk({
        client,
        config,
        root,
        tools: directTools,
        model: model ?? settings.model,
        effort: settings.effort,
        summary: settings.summary,
        temperature: settings.temperature,
        maxOutputTokens: settings.maxOutputTokens,
        instructions,
        maxTurns: maxTurns ?? settings.maxTurns,
        signal,
        onEvent,
    });

    if (role === 'analyzer') return analyzeTask({ ask, task, contextText: contextText ?? '' });
    if (role === 'director') return planWork({ ask, task, analysis, contextText: contextText ?? '' });
    if (role === 'executor') return executePlan({ ask, task, plan, contextText: contextText ?? '' });
    if (role === 'tooler') {
        return runTooler({ ask, task, contextText: contextText ?? '', tools: catalog, root, config, signal });
    }
    return suggestAnswer({ ask, task, contextText: contextText ?? '' });
}

/**
 * The server agent: the analysis, then the plan, then the work.
 *
 * @param {{ task: string, config?: object|null, client: object, root: string, signal?: AbortSignal|null,
 *           onEvent?: Function|null, maxTurns?: number|null, model?: string|null }} options
 * @returns {Promise<{ analysis: object, plan: object, execution: object }>}
 * @exports
 * @ai.hint io
 */
export async function runAgent({ task, ...options } = {}) {
    const analysis = await runRole('analyzer', { ...options, task });
    const plan = await runRole('director', { ...options, task, analysis: analysis.analysis });
    const execution = await runRole('executor', { ...options, task, plan: plan.plan, analysis: analysis.analysis });
    return {
        analysis: analysis.analysis,
        plan: plan.plan,
        execution: {
            steps: execution.steps,
            summary: execution.summary,
            changes: execution.changes,
        },
    };
}

export { chooseTool, callTool, allowedToolNames, runTooler };