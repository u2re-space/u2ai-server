/**
 * @file src/agent/callable.js
 * @module agent/callable
 * @purpose A plain function that answers a task with the model: one step, no plan.
 *
 *   A callable is the smallest form of the agent: the caller names a task and gets an
 *   answer. There is no analysis, no plan and no loop of the tools — one request to the
 *   model with the context of the project, and the answer.
 *
 *   It suits the small asks: a name for a file, a summary of a change, a line of a
 *   commit message. The bigger work belongs to the roles.
 *
 * @depends openai/client, openai/responses, agent/context
 * @usedBy cli, server/u2ai
 * @exports CALLABLE_INSTRUCTIONS, callablePrompt, runCallable
 * @ai.tags agent, callable
 * @ai.hint io
 */

import { createClient } from '../openai/client.js';
import { parseResponse } from '../openai/responses.js';
import { collectRoleContext } from './context.js';

/** The instructions of a callable: answer the task, change nothing. */
export const CALLABLE_INSTRUCTIONS = 'Answer the task of the caller with the context of the project. Read the context, change nothing, and answer with the result.';

/**
 * The prompt of a callable: the task and the context of the project.
 * @param {{ task: string, contextText?: string }} options
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function callablePrompt({ task, contextText = '' } = {}) {
    const lines = [`Task: ${String(task ?? '')}`];
    if (contextText.trim()) lines.push('', 'Context:', contextText.trim());
    return lines.join('\n');
}

/**
 * Answer a task with one request to the model.
 *
 * @param {{ task: string, config?: object|null, client?: object|null, root: string, env?: object,
 *           signal?: AbortSignal|null, onEvent?: Function|null, model?: string|null,
 *           instructions?: string|null, schema?: object|null, schemaName?: string }} options
 * @returns {Promise<{ text: string, data: object|null, usage: object|null, context: object, raw: object }>}
 * @exports
 * @ai.hint io
 */
export async function runCallable({
    task = '',
    config = null,
    client = null,
    root,
    env = process.env,
    signal = null,
    onEvent = null,
    model = null,
    instructions = null,
    schema = null,
    schemaName = 'response',
} = {}) {
    if (!root) throw new Error('The root of the callable is not set.');
    const api = client ?? await createClient({ config: config ?? {}, env, signal, onEvent });
    const context = await collectRoleContext({
        root,
        task,
        role: 'callable',
        home: config?.home ?? null,
    });
    const raw = await api.responses.create({
        model: model ?? config?.model ?? null,
        instructions: instructions ?? CALLABLE_INSTRUCTIONS,
        input: callablePrompt({ task, contextText: context.text }),
        schema,
        schemaName,
        schemaChannel: 'format',
        effort: config?.reasoning?.effort ?? null,
        summary: config?.reasoning?.summary ?? null,
        signal,
        onEvent,
    });
    const parsed = parseResponse(raw, { schemaName });
    return {
        text: parsed.text,
        data: parsed.data,
        usage: parsed.usage,
        context,
        raw,
    };
}
