/**
 * @file src/roles/analyzer.js
 * @module roles/analyzer
 * @purpose Read a task against a project and say what the task really is.
 *
 *   The analyzer answers three questions: what the user wants, which files of the
 *   project the task touches, and what may go wrong. The answer is a plain object, so
 *   the director may build a plan on it and the user may read it.
 *
 * @depends nothing
 * @usedBy roles/index
 * @exports ANALYZER_SCHEMA, analyzerPrompt, shapeAnalysis, analyzeTask
 * @ai.tags roles, analyzer
 * @ai.hint pure
 */

/** The answer of the analyzer. */
export const ANALYZER_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        goal: { type: 'string', description: 'The goal of the task in one sentence.' },
        kind: { type: 'string', description: 'The kind of the work: code, docs, config, answer, or another one.' },
        summary: { type: 'string', description: 'What the task asks for, in a few sentences.' },
        files: {
            type: 'array',
            description: 'The files of the project the task touches.',
            items: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'The path of the file, relative to the root of the project.' },
                    role: { type: 'string', description: 'What to do with the file: edit, read, or scan.' },
                    reason: { type: 'string', description: 'Why the file belongs to the task.' },
                },
                required: ['path', 'role', 'reason'],
                additionalProperties: false,
            },
        },
        risks: { type: 'array', description: 'The risks of the work.', items: { type: 'string' } },
        questions: { type: 'array', description: 'The questions that need an answer before the work.', items: { type: 'string' } },
    },
    required: ['goal', 'kind', 'summary', 'files', 'risks', 'questions'],
    additionalProperties: false,
});

/**
 * The prompt of the analyzer: the task and the context of the project.
 * @param {{ task: string, contextText?: string }} options
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function analyzerPrompt({ task, contextText = '' } = {}) {
    const lines = [
        'Analyze the task against the project.',
        'Name the files the task touches, the risks of the work, and the questions that block it.',
        'Do not write the code: only read and understand.',
        '',
        `Task: ${String(task ?? '')}`,
    ];
    if (contextText.trim()) lines.push('', 'Context:', contextText.trim());
    return lines.join('\n');
}

/**
 * The answer of the analyzer, in the shape the other roles read.
 * @param {object|null} data
 * @returns {{ goal: string, kind: string, summary: string, files: object[], risks: string[], questions: string[] }}
 * @exports
 * @ai.hint pure
 */
export function shapeAnalysis(data) {
    const source = data && typeof data === 'object' ? data : {};
    const files = Array.isArray(source.files) ? source.files : [];
    return {
        goal: typeof source.goal === 'string' ? source.goal : '',
        kind: typeof source.kind === 'string' ? source.kind : '',
        summary: typeof source.summary === 'string' ? source.summary : '',
        files: files
            .filter((item) => item && typeof item.path === 'string')
            .map((item) => ({
                path: item.path,
                role: typeof item.role === 'string' ? item.role : 'read',
                reason: typeof item.reason === 'string' ? item.reason : '',
            })),
        risks: Array.isArray(source.risks) ? source.risks.filter((item) => typeof item === 'string') : [],
        questions: Array.isArray(source.questions) ? source.questions.filter((item) => typeof item === 'string') : [],
    };
}

/**
 * Analyze a task.
 *
 * The `ask` callback is the loop of the role: it sends the prompt to the model and waits
 * for the answer of the schema.
 *
 * @param {{ ask: Function, task: string, contextText?: string }} options
 * @returns {Promise<{ analysis: object, text: string, data: object|null, turns: number, toolCalls: object[] }>}
 * @exports
 * @ai.hint io
 */
export async function analyzeTask({ ask, task, contextText = '' } = {}) {
    const answer = await ask({
        prompt: analyzerPrompt({ task, contextText }),
        schema: ANALYZER_SCHEMA,
        schemaName: 'analysis',
    });
    return { ...answer, analysis: shapeAnalysis(answer?.data) };
}
