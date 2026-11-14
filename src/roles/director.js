/**
 * @file src/roles/director.js
 * @module roles/director
 * @purpose Turn a task into a plan of the work.
 *
 *   The director reads the task and the analysis of the analyzer and writes the steps:
 *   what to do, in which files, and how to check that the step is done. The plan is a
 *   plain object, so the executor may walk through it and the user may read it.
 *
 * @depends nothing
 * @usedBy roles/index
 * @exports DIRECTOR_SCHEMA, directorPrompt, shapePlan, planWork
 * @ai.tags roles, director, plan
 * @ai.hint pure
 */

/** The answer of the director. */
export const DIRECTOR_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        steps: {
            type: 'array',
            description: 'The steps of the work, in the order of the execution.',
            items: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'The short name of the step.' },
                    title: { type: 'string', description: 'The title of the step.' },
                    action: { type: 'string', description: 'What to do in this step.' },
                    files: { type: 'array', description: 'The files of the step.', items: { type: 'string' } },
                    verify: { type: 'string', description: 'How to check that the step is done.' },
                },
                required: ['id', 'title', 'action', 'files', 'verify'],
                additionalProperties: false,
            },
        },
        risks: { type: 'array', description: 'The risks of the plan.', items: { type: 'string' } },
        notes: { type: 'string', description: 'The notes for the executor.' },
    },
    required: ['steps', 'risks', 'notes'],
    additionalProperties: false,
});

/**
 * The prompt of the director: the task, the analysis and the context.
 * @param {{ task: string, analysis?: object|null, contextText?: string }} options
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function directorPrompt({ task, analysis = null, contextText = '' } = {}) {
    const lines = [
        'Write the plan of the work for the task.',
        'Every step names the files it touches and how to check that it is done.',
        '',
        `Task: ${String(task ?? '')}`,
    ];
    if (analysis && typeof analysis === 'object') {
        lines.push('', 'Analysis:', JSON.stringify(analysis, null, 2));
    }
    if (contextText.trim()) lines.push('', 'Context:', contextText.trim());
    return lines.join('\n');
}

/**
 * The answer of the director, in the shape the executor reads.
 * @param {object|null} data
 * @returns {{ steps: object[], risks: string[], notes: string }}
 * @exports
 * @ai.hint pure
 */
export function shapePlan(data) {
    const source = data && typeof data === 'object' ? data : {};
    const steps = Array.isArray(source.steps) ? source.steps : [];
    return {
        steps: steps
            .filter((item) => item && typeof item.action === 'string')
            .map((item, index) => ({
                id: typeof item.id === 'string' && item.id ? item.id : `step-${index + 1}`,
                title: typeof item.title === 'string' ? item.title : '',
                action: item.action,
                files: Array.isArray(item.files) ? item.files.filter((file) => typeof file === 'string') : [],
                verify: typeof item.verify === 'string' ? item.verify : '',
            })),
        risks: Array.isArray(source.risks) ? source.risks.filter((item) => typeof item === 'string') : [],
        notes: typeof source.notes === 'string' ? source.notes : '',
    };
}

/**
 * Write the plan of the work.
 *
 * The `ask` callback is the loop of the role: it sends the prompt to the model and waits
 * for the answer of the schema.
 *
 * @param {{ ask: Function, task: string, analysis?: object|null, contextText?: string }} options
 * @returns {Promise<{ plan: object, text: string, data: object|null, turns: number, toolCalls: object[] }>}
 * @exports
 * @ai.hint io
 */
export async function planWork({ ask, task, analysis = null, contextText = '' } = {}) {
    const answer = await ask({
        prompt: directorPrompt({ task, analysis, contextText }),
        schema: DIRECTOR_SCHEMA,
        schemaName: 'plan',
    });
    return { ...answer, plan: shapePlan(answer?.data) };
}
