/**
 * @file src/tools/cache.js
 * @module tools/cache
 * @purpose Keep the results of the tools of one run, so the same call is not paid twice.
 *
 *   The model often asks for the same file twice in one run: once to look, once to edit
 *   the neighbourhood it just read. The cache answers the second call from the first,
 *   and the run pays for the read once.
 *
 *   The cache lives in the run, not on the disk: it starts empty with every run and dies
 *   with it. A write invalidates the entries of the file it touched, because the world of
 *   the run changed under the cache.
 *
 * @depends node:crypto
 * @usedBy agent/roles, tools/tools
 * @exports createToolCache
 * @ai.tags cache, tools
 * @ai.hint pure
 */

/**
 * The key of one call: the name of the tool and its arguments.
 * @param {string} name
 * @param {object} args
 * @returns {string}
 * @ai.hint pure
 */
function keyOf(name, args) {
    let text;
    try {
        text = JSON.stringify(args ?? {});
    } catch {
        text = String(args);
    }
    return `${name}:${text}`;
}

/**
 * Create the cache of one run.
 *
 * @param {{ maxEntries?: number }} [options]
 * @returns {{ get: Function, set: Function, has: Function, invalidate: Function,
 *             clear: Function, size: () => number }}
 * @exports
 * @ai.hint pure
 */
export function createToolCache({ maxEntries = 256 } = {}) {
    /** @type {Map<string, object>} */
    const entries = new Map();

    /**
     * The result of a call, or undefined when the call was not made yet.
     * @param {string} name
     * @param {object} args
     * @returns {object|undefined}
     * @ai.hint pure
     */
    const get = (name, args) => entries.get(keyOf(name, args));

    /**
     * Remember the result of a call. The oldest entry goes out when the cache is full.
     * @param {string} name
     * @param {object} args
     * @param {object} value
     * @returns {void}
     * @ai.hint pure
     */
    const set = (name, args, value) => {
        const key = keyOf(name, args);
        entries.delete(key);
        entries.set(key, value);
        while (entries.size > maxEntries) {
            const oldest = entries.keys().next().value;
            if (oldest === undefined) break;
            entries.delete(oldest);
        }
    };

    /**
     * Whether the call was made already.
     * @param {string} name
     * @param {object} args
     * @returns {boolean}
     * @ai.hint pure
     */
    const has = (name, args) => entries.has(keyOf(name, args));

    /**
     * Forget the entries of one file: the file was written, so the old answer is a lie.
     * @param {string} file
     * @returns {number} the number of the entries that were dropped
     * @ai.hint pure
     */
    const invalidate = (file) => {
        if (typeof file !== 'string' || !file) return 0;
        let dropped = 0;
        for (const [key, value] of entries) {
            const touches = value?.touches;
            const paths = Array.isArray(touches) ? touches : touches ? [touches] : [];
            if (paths.some((item) => typeof item === 'string' && item.replace(/\\/g, '/') === file.replace(/\\/g, '/'))) {
                entries.delete(key);
                dropped += 1;
            }
        }
        return dropped;
    };

    /** Forget everything. */
    const clear = () => entries.clear();

    /** How many results the cache holds. */
    const size = () => entries.size;

    return { get, set, has, invalidate, clear, size, entries };
}
