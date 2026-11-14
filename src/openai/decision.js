/**
 * @file src/openai/decision.js
 * @module openai/decision
 * @purpose The Decisions API: a model that answers questions with probabilities instead of text.
 *
 *   A decision question is one of three kinds. `noul` asks a yes/no question and the answer is
 *   the probability that the answer is "yes"; `choice` asks which of the named variants fits and
 *   the answer is the probability of each; `score` asks how strong a level is and the answer is
 *   the distribution over the levels.
 *
 *   The route is useful for the things a text model answers badly: moderation, routing, and the
 *   question "is this finished?". It is not a chat route: there is no stream and no tool.
 *
 * @depends openai/http
 * @usedBy openai/client, agent/autocomplete
 * @exports DECISIONS_PATH, buildDecisionBody, parseDecisionAnswer, validateDecisionQuestions
 * @ai.tags openai, decisions
 * @ai.hint pure
 */

/** The route of the decisions API, relative to the base URL of the host. */
export const DECISIONS_PATH = 'decisions';

/** The kinds of question the route knows. */
export const QUESTION_TYPES = Object.freeze(['noul', 'choice', 'score']);

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const textOf = (value) => (typeof value === 'string' ? value : '');

/**
 * The criteria of one question, normalized for the route.
 * @param {string} name
 * @param {string} type
 * @param {unknown} criteria
 * @returns {object|string[]}
 * @ai.hint pure
 */
function criteriaFor(name, type, criteria) {
    if (type === 'noul') {
        if (!isRecord(criteria)) throw new TypeError(`The question ${name} needs criteria.true and criteria.false.`);
        const yes = textOf(criteria.true).trim();
        const no = textOf(criteria.false).trim();
        if (!yes || !no) throw new TypeError(`The question ${name} needs both criteria.true and criteria.false.`);
        return { true: yes, false: no };
    }
    if (type === 'choice') {
        if (!isRecord(criteria)) throw new TypeError(`The question ${name} needs a map of variants.`);
        const entries = Object.entries(criteria);
        if (entries.length < 2) throw new TypeError(`The question ${name} needs at least two variants.`);
        const out = {};
        for (const [key, value] of entries) {
            if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key)) throw new TypeError(`The variant ${name}.${key} must be a latin name.`);
            const text = textOf(value).trim();
            if (!text) throw new TypeError(`The variant ${name}.${key} needs a description.`);
            out[key] = text;
        }
        return out;
    }
    if (!Array.isArray(criteria) || criteria.length < 2 || criteria.some((item) => typeof item !== 'string' || !item.trim())) {
        throw new TypeError(`The question ${name} needs a list of levels, from the lowest to the highest.`);
    }
    return criteria.map((item) => item.trim());
}

/**
 * Check the questions of a request and return a compact copy.
 * @param {object} questions map of name to `{ type, instructions, criteria }`
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function validateDecisionQuestions(questions) {
    if (!isRecord(questions)) throw new TypeError('The questions must be a map of names to questions.');
    const names = Object.keys(questions);
    if (!names.length) throw new TypeError('At least one question is needed.');
    if (names.length > 32) throw new TypeError('At most 32 questions per call.');
    const out = {};
    for (const name of names) {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(name)) throw new TypeError(`The name of the question ${name} must be a latin name.`);
        const question = questions[name];
        if (!isRecord(question)) throw new TypeError(`The question ${name} must be an object.`);
        const type = textOf(question.type);
        if (!QUESTION_TYPES.includes(type)) throw new TypeError(`The question ${name}: type is ${QUESTION_TYPES.join(', ')}.`);
        const instructions = textOf(question.instructions).trim();
        if (!instructions) throw new TypeError(`The question ${name} needs instructions.`);
        if (instructions.length > 2000) throw new TypeError(`The question ${name} has instructions longer than 2000 characters.`);
        out[name] = { type, instructions, criteria: criteriaFor(name, type, question.criteria) };
    }
    return out;
}

/**
 * The body of a decision request.
 *
 * The state is what the questions are asked about: a text, an object, or an array. An empty state
 * is refused — a question about nothing has no answer.
 * @param {{ model?: string|null, state?: string|object|Array, questions?: object }} params
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function buildDecisionBody({ model = null, state = null, questions = null } = {}) {
    const name = textOf(model).trim();
    if (!name) throw new TypeError('A decision model is needed.');
    if (state == null) throw new TypeError('The state is needed.');
    if (typeof state === 'string') {
        if (!state.trim()) throw new TypeError('The state is empty.');
        if (Buffer.byteLength(state) > 256 * 1024) throw new TypeError('The state is larger than 256 KiB.');
    } else if (Array.isArray(state) || isRecord(state)) {
        const encoded = JSON.stringify(state);
        if (!encoded || encoded === '{}' || encoded === '[]') throw new TypeError('The state is empty.');
        if (Buffer.byteLength(encoded) > 256 * 1024) throw new TypeError('The state is larger than 256 KiB.');
    } else {
        throw new TypeError('The state must be a string, an object, or an array.');
    }
    return { model: name, state, questions: validateDecisionQuestions(questions) };
}

/**
 * Read the answer of a decision request.
 *
 * The answer is a map of the question names to the probabilities. A host that answers without
 * that map is not a decision host: the call fails instead of returning an empty answer.
 * @param {object} raw the answer of the host
 * @param {{ model?: string|null }} [options] the model to report when the answer omits its own
 * @returns {{ id: string|null, model: string|null, answers: object, usage: object|null }}
 * @exports
 * @ai.hint pure
 */
export function parseDecisionAnswer(raw, { model = null } = {}) {
    if (!isRecord(raw) || !isRecord(raw.answers)) {
        throw new TypeError('The answer of the decisions route has no answers.');
    }
    return {
        id: raw.id ?? null,
        model: raw.model ?? model,
        answers: raw.answers,
        usage: raw.usage ?? null,
    };
}
