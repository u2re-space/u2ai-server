/**
 * @file src/roles/suggester.js
 * @module roles/suggester
 * @purpose Answer a question about the project and suggest the next steps.
 *
 *   The suggester is the role of the advice: it reads the context of the project, answers
 *   the question of the user, and names the paths and the commands that may help. It
 *   touches nothing.
 *
 * @depends nothing
 * @usedBy roles/index
 * @exports SUGGESTER_SCHEMA, suggesterPrompt, shapeSuggestion, suggestAnswer
 * @ai.tags roles, suggester
 * @ai.hint pure
 */

/** The answer of the suggester. */
export const SUGGESTER_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        answer: { type: 'string', description: 'The answer to the question of the user.' },
        hints: { type: 'array', description: 'The hints about the project.', items: { type: 'string' } },
        paths: { type: 'array', description: 'The paths of the project that matter for the question.', items: { type: 'string' } },
        commands: { type: 'array', description: 'The commands that may help.', items: { type: 'string' } },
    },
    required: ['answer', 'hints', 'paths', 'commands'],
    additionalProperties: false,
});

/**
 * The prompt of the suggester: the question and the context.
 * @param {{ task: string, contextText?: string }} options
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function suggesterPrompt({ task, contextText = '' } = {}) {
    const lines = [
        'Answer the question of the user about the project.',
        'Give the hints, the paths and the commands that help. Change nothing.',
        '',
        `Question: ${String(task ?? '')}`,
    ];
    if (contextText.trim()) lines.push('', 'Context:', contextText.trim());
    return lines.join('\n');
}

/**
 * The answer of the suggester, in the shape the caller reads.
 * @param {object|null} data
 * @returns {{ answer: string, hints: string[], paths: string[], commands: string[] }}
 * @exports
 * @ai.hint pure
 */
export function shapeSuggestion(data) {
    const source = data && typeof data === 'object' ? data : {};
    return {
        answer: typeof source.answer === 'string' ? source.answer : '',
        hints: Array.isArray(source.hints) ? source.hints.filter((item) => typeof item === 'string') : [],
        paths: Array.isArray(source.paths) ? source.paths.filter((item) => typeof item === 'string') : [],
        commands: Array.isArray(source.commands) ? source.commands.filter((item) => typeof item === 'string') : [],
    };
}

/**
 * Answer a question about the project.
 *
 * The `ask` callback is the loop of the role: it sends the prompt to the model and waits
 * for the answer of the schema.
 *
 * @param {{ ask: Function, task: string, contextText?: string }} options
 * @returns {Promise<{ suggestion: object, text: string, data: object|null, turns: number, toolCalls: object[] }>}
 * @exports
 * @ai.hint io
 */
export async function suggestAnswer({ ask, task, contextText = '' } = {}) {
    const answer = await ask({
        prompt: suggesterPrompt({ task, contextText }),
        schema: SUGGESTER_SCHEMA,
        schemaName: 'suggestion',
    });
    return { ...answer, suggestion: shapeSuggestion(answer?.data) };
}
