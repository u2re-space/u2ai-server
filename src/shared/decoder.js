/**
 * @file src/shared/decoder.js
 * @module shared/decoder
 * @purpose Read the frames a client sends: the JSON, the size, the type, and the fields of
 *          every frame the protocol knows.
 *
 * The decoder never throws: it answers with `{ ok: true, frame }` or with
 * `{ ok: false, code, message }`, and the caller turns the second into an error frame.
 *
 * @depends shared/protocol
 * @usedBy server/ws, server/u2ai, server/http
 * @exports decodeFrame, validateFrame, validateStart, validateComplete, validateClaim,
 *          validateToolResult, validateToolsRegister
 * @ai.tags protocol, decoder
 * @ai.hint pure
 */

import {
    MAX_FRAME_BYTES,
    COMMANDS,
    APPROVE_MODES,
    DECISIONS,
    ROLES,
    START_FIELDS,
    REJECTED_START_FIELDS,
    FRAME_TYPES,
    PROCESSABLE_TOOLS,
    MAX_CLIENT_TOOLS,
} from './protocol.js';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const textOf = (value) => (typeof value === 'string' ? value : '');

/** The kinds of a change of a file. */
const CHANGE_OPS = Object.freeze(['create', 'overwrite', 'edit', 'delete']);

/**
 * A failed check.
 * @param {string} code
 * @param {string} message
 * @returns {{ ok: false, code: string, message: string }}
 * @ai.hint pure
 */
function fail(code, message) {
    return { ok: false, code, message };
}

/**
 * Read a frame from the text of the socket.
 * @param {string|Buffer} text
 * @returns {{ ok: true, frame: object } | { ok: false, code: string, message: string }}
 * @exports
 * @ai.hint pure
 */
export function decodeFrame(text) {
    const raw = Buffer.isBuffer(text) ? text.toString('utf8') : String(text ?? '');
    if (Buffer.byteLength(raw, 'utf8') > MAX_FRAME_BYTES) {
        return fail('too_large', `The frame is bigger than ${MAX_FRAME_BYTES} bytes.`);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        return fail('bad_json', `The frame is not valid JSON: ${error.message}`);
    }
    if (!isRecord(parsed)) return fail('bad_request', 'The frame must be a JSON object.');
    if (typeof parsed.type !== 'string' || !parsed.type) {
        return fail('bad_request', 'The frame must name its type.');
    }
    return validateFrame(parsed);
}

/**
 * Check the fields of one frame.
 * @param {object} frame
 * @returns {{ ok: true, frame: object } | { ok: false, code: string, message: string }}
 * @exports
 * @ai.hint pure
 */
export function validateFrame(frame) {
    if (!FRAME_TYPES.includes(frame.type)) {
        return fail('unknown_type', `Unknown frame type: ${frame.type}.`);
    }
    switch (frame.type) {
        case 'hello': {
            if (!textOf(frame.token).trim()) return fail('bad_request', 'The hello frame needs a token.');
            if (!ROLES.includes(frame.role)) return fail('bad_request', 'The role must be client or publisher.');
            if (frame.name !== undefined && typeof frame.name !== 'string') {
                return fail('bad_request', 'The name of the client must be a string.');
            }
            return { ok: true, frame };
        }
        case 'tools.register':
            return validateToolsRegister(frame);
        case 'start':
            return validateStart(frame);
        case 'input': {
            if (!textOf(frame.runId).trim()) return fail('bad_request', 'The input frame needs a runId.');
            if (frame.text !== undefined && typeof frame.text !== 'string') {
                return fail('bad_request', 'The text of the input frame must be a string.');
            }
            return { ok: true, frame };
        }
        case 'approve': {
            if (!textOf(frame.requestId).trim()) return fail('bad_request', 'The approve frame needs a requestId.');
            if (!DECISIONS.includes(frame.decision)) {
                return fail('bad_request', `The decision must be one of: ${DECISIONS.join(', ')}.`);
            }
            return { ok: true, frame };
        }
        case 'answer': {
            if (!textOf(frame.requestId).trim()) return fail('bad_request', 'The answer frame needs a requestId.');
            if (frame.text !== undefined && typeof frame.text !== 'string') {
                return fail('bad_request', 'The text of the answer frame must be a string.');
            }
            return { ok: true, frame };
        }
        case 'complete':
            return validateComplete(frame);
        case 'processing.claim':
            return validateClaim(frame);
        case 'tool.result':
            return validateToolResult(frame);
        case 'cancel': {
            if (!textOf(frame.runId).trim()) return fail('bad_request', 'The cancel frame needs a runId.');
            return { ok: true, frame };
        }
        case 'subscribe':
        case 'unsubscribe': {
            if (!textOf(frame.runId).trim()) return fail('bad_request', 'The frame needs a runId.');
            return { ok: true, frame };
        }
        case 'ping':
            return { ok: true, frame };
        default:
            return fail('unknown_type', `Unknown frame type: ${frame.type}.`);
    }
}

/**
 * Check the fields of a `start` frame.
 *
 * The list of the fields is closed: a field the server does not know is a mistake of the
 * client, and a silent mistake is worse than a clear error. The fields `background`, `detach`
 * and `job` are refused by name: a run that outlives its socket has no place in this bus.
 * @param {object} frame
 * @returns {{ ok: true, frame: object } | { ok: false, code: string, message: string }}
 * @exports
 * @ai.hint pure
 */
export function validateStart(frame) {
    for (const key of Object.keys(frame)) {
        if (REJECTED_START_FIELDS.includes(key)) {
            return fail('invalid_start', `The field ${key} is not supported by the bus.`);
        }
        if (!START_FIELDS.includes(key)) {
            return fail('invalid_start', `Unknown field: ${key}.`);
        }
    }
    if (!COMMANDS.includes(frame.command)) {
        return fail('invalid_start', `The command must be one of: ${COMMANDS.join(', ')}.`);
    }
    if (frame.command !== 'chat' && !textOf(frame.prompt).trim()) {
        return fail('invalid_start', 'The prompt is needed.');
    }
    if (frame.prompt !== undefined && typeof frame.prompt !== 'string') {
        return fail('invalid_start', 'The prompt must be a string.');
    }
    if (frame.cwd !== undefined && typeof frame.cwd !== 'string') {
        return fail('invalid_start', 'The cwd must be a string.');
    }
    if (frame.approve !== undefined && !APPROVE_MODES.includes(frame.approve)) {
        return fail('invalid_start', `The approve mode must be one of: ${APPROVE_MODES.join(', ')}.`);
    }
    if (frame.processing !== undefined) {
        if (!Array.isArray(frame.processing)) {
            return fail('invalid_start', 'The processing must be a list of tool names.');
        }
        const seen = new Set();
        for (const name of frame.processing) {
            if (typeof name !== 'string' || !PROCESSABLE_TOOLS.includes(name)) {
                return fail('invalid_start', `The tool is not available for the capture: ${String(name)}.`);
            }
            if (seen.has(name)) return fail('invalid_start', `The name of the tool repeats: ${name}.`);
            seen.add(name);
        }
    }
    return { ok: true, frame };
}

/**
 * Check the fields of a `tools.register` frame.
 *
 * A client publishes the tools of its own: the file system of the editor, the terminal of
 * the editor. Every tool needs a name, and the name may not repeat inside the list.
 *
 * @param {object} frame
 * @returns {{ ok: true, frame: object } | { ok: false, code: string, message: string }}
 * @exports
 * @ai.hint pure
 */
export function validateToolsRegister(frame) {
    if (!Array.isArray(frame.tools)) return fail('bad_request', 'The tools.register frame needs a list of tools.');
    if (frame.tools.length > MAX_CLIENT_TOOLS) {
        return fail('bad_request', `The list of the tools is longer than ${MAX_CLIENT_TOOLS}.`);
    }
    const seen = new Set();
    for (const tool of frame.tools) {
        if (!isRecord(tool)) return fail('bad_request', 'A tool must be an object.');
        const name = textOf(tool.name).trim();
        if (!name) return fail('bad_request', 'A tool needs a name.');
        if (name.length > 80) return fail('bad_request', `The name of the tool is too long: ${name}.`);
        if (seen.has(name)) return fail('bad_request', `The name of the tool repeats: ${name}.`);
        seen.add(name);
        if (tool.description !== undefined && typeof tool.description !== 'string') {
            return fail('bad_request', `The description of the tool ${name} must be a string.`);
        }
        if (tool.parameters !== undefined && !isRecord(tool.parameters)) {
            return fail('bad_request', `The parameters of the tool ${name} must be an object.`);
        }
    }
    return { ok: true, frame };
}

/**
 * Check the fields of a `processing.claim` frame.
 *
 * The list of the tools is closed: a client may hold only the tools of the protocol, and
 * a name may not repeat.
 *
 * @param {object} frame
 * @returns {{ ok: true, frame: object } | { ok: false, code: string, message: string }}
 * @exports
 * @ai.hint pure
 */
export function validateClaim(frame) {
    if (!textOf(frame.runId).trim()) return fail('bad_request', 'The processing.claim frame needs a runId.');
    if (!Array.isArray(frame.tools)) return fail('bad_request', 'The tools must be a list of tool names.');
    const seen = new Set();
    for (const name of frame.tools) {
        if (typeof name !== 'string' || !PROCESSABLE_TOOLS.includes(name)) {
            return fail('bad_request', `The tool is not available for the capture: ${String(name)}.`);
        }
        if (seen.has(name)) return fail('bad_request', `The name of the tool repeats: ${name}.`);
        seen.add(name);
    }
    return { ok: true, frame };
}

/**
 * Check the fields of a `tool.result` frame.
 *
 * The answer of a holder is either an error or a text: `output` is what the tool printed,
 * `summary` is one line about it, and `changes` are the files it touched.
 *
 * @param {object} frame
 * @returns {{ ok: true, frame: object } | { ok: false, code: string, message: string }}
 * @exports
 * @ai.hint pure
 */
export function validateToolResult(frame) {
    if (!textOf(frame.requestId).trim()) return fail('bad_request', 'The tool.result frame needs a requestId.');
    if (frame.error !== undefined && typeof frame.error !== 'string') {
        return fail('bad_request', 'The error must be a string.');
    }
    if (typeof frame.error === 'string' && frame.error.trim()) return { ok: true, frame };
    if (typeof frame.output !== 'string' || typeof frame.summary !== 'string') {
        return fail('bad_request', 'The output and the summary must be strings.');
    }
    if (frame.changes !== undefined) {
        if (!Array.isArray(frame.changes)) return fail('bad_request', 'The changes must be a list.');
        for (const change of frame.changes) {
            if (!isRecord(change)) return fail('bad_request', 'A change must be an object.');
            if (!CHANGE_OPS.includes(change.op)) {
                return fail('bad_request', `The op of a change must be one of: ${CHANGE_OPS.join(', ')}.`);
            }
            if (typeof change.path !== 'string' || !change.path.trim()) {
                return fail('bad_request', 'The path of a change must be a string.');
            }
        }
    }
    return { ok: true, frame };
}

/**
 * Check the fields of a `complete` frame.
 * @param {object} frame
 * @returns {{ ok: true, frame: object } | { ok: false, code: string, message: string }}
 * @exports
 * @ai.hint pure
 */
export function validateComplete(frame) {
    if (!textOf(frame.id).trim()) return fail('bad_request', 'The complete frame needs an id.');
    if (typeof frame.content !== 'string') return fail('bad_request', 'The content must be a string.');
    if (frame.language !== undefined && typeof frame.language !== 'string') {
        return fail('bad_request', 'The language must be a string.');
    }
    if (frame.path !== undefined && typeof frame.path !== 'string') {
        return fail('bad_request', 'The path must be a string.');
    }
    if (!isRecord(frame.cursor)) return fail('bad_request', 'The cursor must be an object.');
    if (!Number.isSafeInteger(frame.cursor.line) || frame.cursor.line < 0) {
        return fail('bad_request', 'The line of the cursor must be a whole number.');
    }
    if (!Number.isSafeInteger(frame.cursor.character) || frame.cursor.character < 0) {
        return fail('bad_request', 'The character of the cursor must be a whole number.');
    }
    return { ok: true, frame };
}
