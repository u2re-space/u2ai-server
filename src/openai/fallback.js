/**
 * @file src/openai/fallback.js
 * @module openai/fallback
 * @purpose Model fallback: a chain of models to try when one refuses or fails.
 * @depends model/refs
 * @exports fallbackChain, withModelFallback, fallbackModels, fallbackWorthy, modelRefusal
 * @ai.tags fallback
 * @ai.hint pure
 * @ai.hint legacy-0.2
 */

import { familyLadder, groupLadder } from '../model/refs.js';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const textOf = (value) => (typeof value === 'string' ? value : '');

/**
 * The models to try after the given one: the list under `fallback.models.<model>`, then the
 * ladder of the budget of the family of the model and the peers of its group, then the list
 * under `fallback.models.*` (the catch-all chain).
 * @param {object} config
 * @param {string|null} model
 * @returns {string[]}
 * @exports
 */
export function fallbackModels(config, model) {
    if (config?.fallback?.enabled === false) return [];
    const map = config?.fallback?.models;
    const pick = (list) => (Array.isArray(list)
        ? list.map((item) => (typeof item === 'string' ? item : textOf(item?.model))).filter(Boolean)
        : []);
    const own = isRecord(map) ? pick(map[model]) : [];
    const shared = isRecord(map) ? pick(map['*']) : [];
    const ladder = [...familyLadder(config, model), ...groupLadder(config, model)]
        .filter((item) => !own.includes(item));
    return [
        ...own,
        ...ladder,
        ...shared.filter((item) => !own.includes(item) && !ladder.includes(item)),
    ];
}

/**
 * The full chain of models for a request: the requested model first, then its fallbacks.
 * @param {object} config
 * @param {string|null} model
 * @returns {string[]}
 * @exports
 */
export function fallbackChain(config, model) {
    const chain = [];
    if (model) chain.push(model);
    for (const item of fallbackModels(config, model)) if (!chain.includes(item)) chain.push(item);
    return chain;
}

/**
 * Whether an error is worth another model.
 *
 * A missing model, an overload or a gateway hiccup is: another model may survive it. A refused
 * request is not: the request itself is wrong, and the next model will refuse it too.
 *
 * The exception is a refusal of the model alone. "This model is not allowed for this key" and
 * "this model does not exist" say nothing about the request, and the next model of the chain
 * may well be allowed — so they are worth another try even though the status is 401 or 403.
 * @param {Error & { status?: number, code?: string, apiCode?: string, param?: string }} error
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function fallbackWorthy(error) {
    if (!error) return false;
    if (error?.name === 'AbortError' || error?.code === 'ABORTED') return false;
    if (modelRefusal(error)) return true;
    const status = Number.isSafeInteger(error?.status) ? error.status : null;
    if (status === 401 || status === 403 || status === 422) return false;
    return true;
}

/**
 * Whether the error refuses the model itself and not the request.
 * @param {Error & { status?: number, code?: string, apiCode?: string, param?: string }} error
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function modelRefusal(error) {
    if (!error) return false;
    if (error?.param === 'model') return true;
    const details = `${textOf(error?.apiCode)} ${textOf(error?.code)} ${textOf(error?.message)}`;
    if (/model_not_found|model_not_available|invalid_model|unknown_model/i.test(details)) return true;
    if (/model[^.]{0,60}(is not allowed|not allowed for|does not exist|not found|unavailable|unknown)/i.test(details)) return true;
    return false;
}

/**
 * Run a call with the model chain: the next model is tried when the call fails with an
 * error that another model may survive (a refused request, an overload, a missing model).
 * @param {{ config: object, model: string|null, call: (model: string|null) => Promise<any>,
 *   onTry?: Function|null, worthy?: Function|null }} params
 * @returns {Promise<{ result: any, model: string|null, attempts: Array<{ model: string|null, error: string }> }>}
 * @exports
 */
export async function withModelFallback({ config, model, call, onTry = null, worthy = fallbackWorthy }) {
    const chain = fallbackChain(config, model);
    if (!chain.length) chain.push(model ?? null);
    const attempts = [];
    let lastError = null;
    for (const candidate of chain) {
        try {
            onTry?.({ model: candidate, attempt: attempts.length + 1 });
            const result = await call(candidate);
            return { result, model: candidate, attempts };
        } catch (error) {
            lastError = error;
            attempts.push({ model: candidate, error: error?.message ?? String(error) });
            if (!worthy(error)) break;
        }
    }
    throw lastError ?? new Error('No model answered the request.');
}
