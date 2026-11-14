/**
 * @file src/roles/executor.js
 * @module roles/executor
 * @purpose Walk through the steps of the plan and do them with the tools.
 *
 *   The executor takes the plan of the director and runs it step by step. Every step is
 *   one request to the model with the tools of the catalog: the model reads the step,
 *   calls the tools it needs, and reports what happened with the step. A failed step does
 *   not stop the work — it is reported, and the next step still runs.
 *
 * @depends nothing
 * @usedBy roles/index
 * @exports EXECUTOR_SCHEMA, executorPrompt, shapeStepReport, executePlan
 * @ai.tags roles, executor, tools
 * @ai.hint pure
 */

/** The report of one step of the plan. */
export const EXECUTOR_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        status: {
            type: 'string',
            enum: ['done', 'failed', 'skipped'],
            description: 'What happened with the step.',
        },
        note: { type: 'string', description: 'What was done, or why the step failed.' },
        files: { type: 'array', description: 'The files the step changed.', items: { type: 'string' } },
    },
    required: ['status', 'note', 'files'],
    additionalProperties: false,
});

/**
 * The prompt of one step: the task, the step and the context.
 * @param {{ task: string, step: object, contextText?: string }} options
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function executorPrompt({ task, step, contextText = '' } = {}) {
    const lines = [
        'Do this step of the plan.',
        'Use the tools when the work touches the disk. Report the result of the step when it is done.',
        '',
        `Task: ${String(task ?? '')}`,
        '',
        `Step: ${step?.title ?? step?.id ?? ''}`,
        `Action: ${step?.action ?? ''}`,
    ];
    if (step?.files?.length) lines.push(`Files: ${step.files.join(', ')}`);
    if (step?.verify) lines.push(`Check: ${step.verify}`);
    if (contextText.trim()) lines.push('', 'Context:', contextText.trim());
    return lines.join('\n');
}

/**
 * The report of one step, in the shape the answer reads.
 * @param {object|null} data
 * @returns {{ status: string, note: string, files: string[] }}
 * @exports
 * @ai.hint pure
 */
export function shapeStepReport(data) {
    const source = data && typeof data === 'object' ? data : {};
    const status = ['done', 'failed', 'skipped'].includes(source.status) ? source.status : 'failed';
    return {
        status,
        note: typeof source.note === 'string' ? source.note : '',
        files: Array.isArray(source.files) ? source.files.filter((file) => typeof file === 'string') : [],
    };
}

/**
 * Run the steps of the plan.
 *
 * The `ask` callback is the loop of the role: it sends the prompt to the model with the
 * tools and waits for the answer of the schema.
 *
 * @param {{ ask: Function, task: string, plan?: object|null, contextText?: string }} options
 * @returns {Promise<{ steps: object[], summary: string, changes: string[], toolCalls: object[], turns: number }>}
 * @exports
 * @ai.hint io
 */
export async function executePlan({ ask, task, plan = null, contextText = '' } = {}) {
    const steps = Array.isArray(plan?.steps) ? plan.steps : [];
    const reports = [];
    const calls = [];
    let turns = 0;
    for (const step of steps) {
        const answer = await ask({
            prompt: executorPrompt({ task, step, contextText }),
            schema: EXECUTOR_SCHEMA,
            schemaName: 'step_report',
        });
        turns += Number.isSafeInteger(answer?.turns) ? answer.turns : 0;
        for (const call of answer?.toolCalls ?? []) calls.push(call);
        reports.push({
            id: step.id,
            title: step.title,
            ...shapeStepReport(answer?.data),
        });
    }
    const done = reports.filter((item) => item.status === 'done').length;
    const failed = reports.filter((item) => item.status === 'failed').length;
    const changes = [...new Set(reports.flatMap((item) => item.files))];
    return {
        steps: reports,
        summary: steps.length
            ? `${done} of ${steps.length} steps are done, ${failed} failed.`
            : 'The plan has no steps.',
        changes,
        toolCalls: calls,
        turns,
    };
}
