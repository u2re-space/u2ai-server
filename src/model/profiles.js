/**
 * @file src/model/profiles.js
 * @module model/profiles
 * @purpose Model profiles: the context window, the output cap, the effort ceiling and the
 *          effort ladder of a model.
 * @depends config/constants
 * @usedBy agent/context, agent/autocomplete, roles/index
 * @exports MODEL_PROFILES, getModelProfile, snapEffort, contextBytes, maxOutputFor
 * @ai.tags model, profiles
 * @ai.hint pure
 */
import { ENUMS } from '../config/constants.js';

/**
 * @typedef {{ window: number, maxOutput: number, ceiling: string|null, efforts: string[]|null }} ModelProfile
 */

/**
 * Built-in model profiles. A ceiling of `null` means "no built-in limit".
 *
 * The server answers with a light model: the tools do the work, the model plans it. The window
 * and the output cap of the house are the same for every model — the context of the agent is
 * bounded by the service, not by the card of the model. The ceiling of the effort and the ladder
 * of the levels are the ones of the model (the cards of RouterAI, November 2026):
 *
 *   - Gemini 4 Hydrogen — the levels of the effort are `low`, `medium`, `high` and `xhigh`;
 *     there is no `none`, so the reasoning off is raised to `low`.
 *   - Kimi K3.1 Pro — it takes the reasoning off without a refusal and answers in a fraction of
 *     the time, so `none` stays on its ladder; the ceiling is `medium`, because the levels above
 *     it cost the same seconds. The model is the fallback of the house.
 */
export const MODEL_PROFILES = Object.freeze({
    'minimax/minimax-m3.1-flash': { window: 262_144, maxOutput: 32_768, ceiling: 'high', efforts: ['low', 'medium', 'high'] },
    'google/gemini-4-hydrogen': { window: 262_144, maxOutput: 32_768, ceiling: 'xhigh', efforts: ['low', 'medium', 'high', 'xhigh'] },
    'moonshotai/kimi-k3': { window: 262_144, maxOutput: 32_768, ceiling: 'high', efforts: ['low', 'medium', 'high'] },
    'moonshotai/kimi-k3.1-pro': { window: 262_144, maxOutput: 32_768, ceiling: 'medium', efforts: ['none', 'low', 'medium'] },
    'openai/gpt-5.1': { window: 262_144, maxOutput: 32_768, ceiling: 'high', efforts: ['low', 'medium', 'high'] },
    'openai/gpt-6.1-sol': { window: 262_144, maxOutput: 32_768, ceiling: 'xhigh', efforts: ['low', 'medium', 'high', 'xhigh'] },
    'openai/gpt-6.1-terra': { window: 262_144, maxOutput: 16_384, ceiling: 'high', efforts: ['low', 'medium', 'high'] },
    'openai/gpt-6-luna': { window: 131_072, maxOutput: 8_192, ceiling: 'medium', efforts: ['low', 'medium'] },
});

/** The profile of a model that is not in the table. */
const DEFAULT_PROFILE = Object.freeze({
    window: 131_072,
    maxOutput: 16_384,
    ceiling: 'medium',
    efforts: ['low', 'medium', 'high'],
});

/**
 * The profile of a model, with the `models` section of the config applied on top.
 * @param {string|null} model
 * @param {object} [config]
 * @returns {ModelProfile}
 * @exports
 */
export function getModelProfile(model, config = null) {
    const base = MODEL_PROFILES[model] ?? DEFAULT_PROFILE;
    const override = config?.models?.[model];
    if (!override || typeof override !== 'object') return base;
    return {
        window: Number.isSafeInteger(override.window) ? override.window : base.window,
        maxOutput: Number.isSafeInteger(override.maxOutput) ? override.maxOutput : base.maxOutput,
        ceiling: override.ceiling === null ? null : (override.ceiling ?? base.ceiling),
        efforts: Array.isArray(override.efforts) ? override.efforts : base.efforts,
    };
}

/**
 * The order of the effort levels, from the cheapest to the most expensive.
 * @type {string[]}
 */
const EFFORT_ORDER = Object.freeze([...ENUMS.reasoningEfforts]);

/**
 * Clamp an effort to what the model accepts.
 *
 * The ceiling is a hard limit. The ladder is a set of levels the model really understands:
 * a level above the ladder is pulled down to the closest level below it.
 * @param {string|null} effort
 * @param {ModelProfile} profile
 * @returns {string|null}
 * @exports
 */
export function snapEffort(effort, profile) {
    if (!effort) return null;
    const wanted = String(effort);
    if (!EFFORT_ORDER.includes(wanted)) return null;

    const ceiling = profile?.ceiling ?? null;
    if (ceiling && EFFORT_ORDER.includes(ceiling)) {
        const ceilingIndex = EFFORT_ORDER.indexOf(ceiling);
        const wantedIndex = EFFORT_ORDER.indexOf(wanted);
        if (wantedIndex > ceilingIndex) return ceiling;
    }

    const ladder = Array.isArray(profile?.efforts) ? profile.efforts.filter((item) => EFFORT_ORDER.includes(item)) : null;
    if (!ladder || !ladder.length) return wanted;
    if (ladder.includes(wanted)) return wanted;

    const wantedIndex = EFFORT_ORDER.indexOf(wanted);
    let best = null;
    for (const item of ladder) {
        const index = EFFORT_ORDER.indexOf(item);
        if (index <= wantedIndex && (best === null || index > EFFORT_ORDER.indexOf(best))) best = item;
    }
    return best ?? ladder[0];
}

/**
 * The context budget in bytes.
 *
 * A word (`small`, `normal`, `large`, `max`) is a fixed budget; `auto` is the window of the
 * model; a number is a byte count.
 * @param {string|number|null} level
 * @param {ModelProfile} profile
 * @returns {number}
 * @exports
 */
export function contextBytes(level, profile) {
    if (Number.isSafeInteger(level) && level > 0) return level;
    const word = String(level ?? 'auto').trim().toLowerCase();
    if (word === 'auto') return Math.max(0, profile?.window ?? DEFAULT_PROFILE.window);
    const known = ENUMS.contextLevels[word];
    if (known) return known;
    const parsed = Number.parseInt(word, 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
    return Math.max(0, profile?.window ?? DEFAULT_PROFILE.window);
}

/**
 * The output cap of a model for a request.
 * @param {string|null} model
 * @param {object} [config]
 * @param {number|null} [requested]
 * @returns {number|null}
 * @exports
 */
export function maxOutputFor(model, config = null, requested = null) {
    const profile = getModelProfile(model, config);
    if (Number.isSafeInteger(requested) && requested > 0) {
        return profile.maxOutput > 0 ? Math.min(requested, profile.maxOutput) : requested;
    }
    return profile.maxOutput > 0 ? profile.maxOutput : null;
}
