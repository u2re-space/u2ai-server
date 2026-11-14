/**
 * @file src/roles/tooler.js
 * @module roles/tooler
 * @purpose Choose the tool that fits a task and call it.
 *
 *   The tooler is the role that touches the disk. It reads the catalog of the tools,
 *   asks the model which of them fits the task, checks the answer against the catalog,
 *   and runs the tool. A tool that the configuration forbids is never offered and never
 *   runs.
 *
 *   The arguments of the tool travel as a JSON text: the schema of the answer stays
 *   strict, and the dispatcher still gets a plain object.
 *
 * @depends tools/tools
 * @usedBy roles/index, roles/executor, agent/callable
 * @exports TOOLER_SCHEMA, toolerPrompt, parseToolArguments, chooseTool, callTool,
 *          runTooler, allowedToolNames
 * @ai.tags roles, tools
 * @ai.hint io
 */

import { TOOL_NAMES, TOOL_SPECS, executeTool, describeTool, toolAllowed } from '../tools/tools.js';

/** The answer of the tooler: the name of the tool, its arguments and the reason. */
export const TOOLER_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        tool: { type: 'string', description: 'The name of the tool to call. An empty name means that no tool is needed.' },
        arguments: { type: 'string', description: 'The arguments of the tool as a JSON object, for example {"path":"src/index.js"}.' },
        reason: { type: 'string', description: 'Why this tool fits the task.' },
    },
    required: ['tool', 'arguments', 'reason'],
    additionalProperties: false,
});

/**
 * The names of the tools the configuration allows.
 *
 * The flags of the configuration decide it: `tools.read`, `tools.write`,
 * `tools.allowTerminal` and the flags of the groups. A role may narrow the list further
 * in `roles.<name>.tools` — the role runner does that.
 *
 * @param {object|null} config the resolved configuration
 * @param {string[]} [names] the catalog to filter
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function allowedToolNames(config = null, names = TOOL_NAMES) {
    return (Array.isArray(names) ? names : TOOL_NAMES)
        .filter((name) => TOOL_SPECS[name])
        .filter((name) => toolAllowed(name, config));
}

/**
 * The prompt of the tooler: the task, the context and the catalog.
 * @param {{ task: string, contextText?: string, tools?: string[] }} options
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function toolerPrompt({ task, contextText = '', tools = [] } = {}) {
    const lines = ['Choose the tool that fits the task.', '', `Task: ${String(task ?? '')}`];
    if (contextText.trim()) lines.push('', 'Context:', contextText.trim());
    lines.push('', 'Tools:');
    if (!tools.length) lines.push('- (none)');
    for (const name of tools) {
        const spec = describeTool(name);
        if (!spec) continue;
        lines.push(`- ${name} (${spec.category}, ${spec.risk}): ${spec.description}`);
    }
    lines.push('', 'Answer with the tool and its arguments. Answer with an empty tool when no tool is needed.');
    return lines.join('\n');
}

/**
 * The arguments of a tool: a JSON object, or an empty one when the text is broken.
 *
 * A model may wrap the object in a line of prose; the first object of the text is taken.
 *
 * @param {unknown} value
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function parseToolArguments(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    const text = String(value ?? '').trim();
    if (!text) return {};
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* the text is not the whole object */ }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
        try {
            const parsed = JSON.parse(text.slice(start, end + 1));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        } catch { /* the object is broken */ }
    }
    return {};
}

/**
 * Ask the model which tool fits the task.
 *
 * The `ask` callback is the loop of the role: it sends the prompt to the model and waits
 * for the answer of the schema.
 *
 * @param {{ ask: Function, task: string, contextText?: string, tools?: string[] }} options
 * @returns {Promise<{ tool: string, arguments: object, reason: string, answer: object }>}
 * @exports
 * @ai.hint io
 */
export async function chooseTool({ ask, task, contextText = '', tools = [] } = {}) {
    const answer = await ask({
        prompt: toolerPrompt({ task, contextText, tools }),
        schema: TOOLER_SCHEMA,
        schemaName: 'tool_choice',
    });
    const data = answer?.data ?? {};
    return {
        tool: typeof data.tool === 'string' ? data.tool.trim() : '',
        arguments: parseToolArguments(data.arguments),
        reason: typeof data.reason === 'string' ? data.reason : '',
        answer,
    };
}

/**
 * Run one tool of the catalog and keep the failure as a result.
 *
 * A tool that fails is not a crash: the role reads the message and decides what to do.
 *
 * @param {string} name
 * @param {object} args
 * @param {{ root: string, config?: object|null, signal?: AbortSignal|null }} context
 * @returns {Promise<{ ok: boolean, name: string, text: string, data: object|null, error: string|null }>}
 * @exports
 * @ai.hint io
 */
export async function callTool(name, args = {}, { root, config = null, signal = null } = {}) {
    try {
        const out = await executeTool(name, args, { root, config, signal });
        return {
            ok: true,
            name,
            text: typeof out?.text === 'string' ? out.text : JSON.stringify(out?.data ?? null),
            data: out?.data ?? null,
            error: null,
        };
    } catch (error) {
        const message = error?.message ?? String(error);
        return { ok: false, name, text: message, data: null, error: message };
    }
}

/**
 * Choose a tool and run it.
 *
 * The model picks the tool from the catalog; the runner runs it and keeps the result.
 *
 * @param {{ ask: Function, task: string, contextText?: string, tools?: string[], root: string,
 *           config?: object|null, signal?: AbortSignal|null }} options
 * @returns {Promise<{ tool: string, arguments: object, reason: string, result: object|null, answer: object }>}
 * @exports
 * @ai.hint io
 */
export async function runTooler({ ask, task, contextText = '', tools = [], root, config = null, signal = null } = {}) {
    const choice = await chooseTool({ ask, task, contextText, tools });
    if (!choice.tool) return { ...choice, result: null };
    const result = await callTool(choice.tool, choice.arguments, { root, config, signal });
    return { ...choice, result };
}
