/**
 * @file src/shared/encoder.js
 * @module shared/encoder
 * @purpose Build the frames the server sends: the values are sanitized, the frame is measured
 *          against the limit, and the completion window shrinks until the frame fits.
 * @depends shared/protocol
 * @usedBy server/ws, server/u2ai, server/http, agent/autocomplete
 * @exports sanitizeValue, encodeFrame, errorFrame, readyFrame, runStartedFrame, runEndedFrame,
 *          runEventFrame, textDeltaFrame, reasoningDeltaFrame, toolExecStartFrame,
 *          toolExecDoneFrame, warningFrame, errorEventFrame, imageSavedFrame, imageProgressFrame,
 *          responseDoneFrame, approvalRequestFrame, questionRequestFrame, completionFrame,
 *          toolCallFrame, toolsRegisteredFrame, buildCompletionFrame
 * @ai.tags protocol, encoder
 * @ai.hint pure
 */

import {
    MAX_FRAME_BYTES,
    MAX_COMPLETION_CONTEXT_BYTES,
    MAX_COMPLETION_FRAME_BYTES,
    COMPLETION_WINDOWS,
    PROTOCOL_VERSION,
} from './protocol.js';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const textOf = (value) => (typeof value === 'string' ? value : '');

/**
 * Make a value safe to put into a frame.
 *
 * The values of an event come from the model and from the tools: they may hold anything. A
 * function, a symbol or a cycle must not reach the wire, a long string must not blow the frame
 * up, and a deep tree must not eat the stack of the reader.
 * @param {unknown} value
 * @param {{ maxDepth?: number, maxString?: number, maxItems?: number, maxKeys?: number }} [options]
 * @returns {unknown}
 * @exports
 * @ai.hint pure
 */
export function sanitizeValue(value, {
    maxDepth = 8,
    maxString = 64 * 1024,
    maxItems = 1000,
    maxKeys = 500,
} = {}) {
    /**
     * One value, with the depth left.
     * @param {unknown} node
     * @param {number} depth
     * @param {WeakSet<object>} seen the objects on the way down
     * @returns {unknown}
     * @ai.hint pure
     */
    function walk(node, depth, seen) {
        if (node === null || node === undefined) return null;
        const type = typeof node;
        if (type === 'string') return node.length > maxString ? `${node.slice(0, maxString)}…` : node;
        if (type === 'number') return Number.isFinite(node) ? node : null;
        if (type === 'boolean') return node;
        if (type === 'bigint') return node.toString();
        if (type === 'function' || type === 'symbol') return null;
        if (node instanceof Date) return node.toISOString();
        if (node instanceof Error) return { name: node.name, message: node.message };
        if (depth >= maxDepth) return '[deep]';
        if (seen.has(node)) return '[circular]';

        seen.add(node);
        try {
            if (Array.isArray(node)) {
                const out = [];
                for (const item of node.slice(0, maxItems)) out.push(walk(item, depth + 1, seen));
                if (node.length > maxItems) out.push(`…${node.length - maxItems} more`);
                return out;
            }
            if (node instanceof Map) return walk(Object.fromEntries(node), depth + 1, seen);
            if (node instanceof Set) return walk([...node], depth + 1, seen);
            const out = {};
            let count = 0;
            for (const [key, item] of Object.entries(node)) {
                if (count >= maxKeys) { out['…'] = `${Object.keys(node).length - count} more`; break; }
                out[String(key)] = walk(item, depth + 1, seen);
                count += 1;
            }
            return out;
        } finally {
            seen.delete(node);
        }
    }

    return walk(value, 0, new WeakSet());
}

/**
 * Encode a frame into the text that goes into the socket.
 *
 * A frame bigger than the limit is an error of the caller, not of the client: the values were
 * too big, and the caller has to cut them.
 * @param {object} frame
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function encodeFrame(frame) {
    const text = JSON.stringify(sanitizeValue(frame));
    if (Buffer.byteLength(text, 'utf8') > MAX_FRAME_BYTES) {
        const error = new Error(`The frame is bigger than ${MAX_FRAME_BYTES} bytes.`);
        error.code = 'too_large';
        throw error;
    }
    return text;
}

/**
 * The frame of an error.
 * @param {string} code
 * @param {string} message
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function errorFrame(code, message) {
    return { type: 'error', code, message };
}

/**
 * The answer to `hello`: the server is ready, and these runs are already going.
 * @param {object[]} runs
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function readyFrame(runs = []) {
    return { type: 'ready', protocol: PROTOCOL_VERSION, runs: Array.isArray(runs) ? runs : [] };
}

/**
 * The frame that announces a run.
 * @param {{ id: string, source?: string, command?: string, title?: string, cwd?: string, status?: string, startedAt?: string }} run
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function runStartedFrame(run) {
    return {
        type: 'run.started',
        run: {
            id: run?.id ?? null,
            source: run?.source ?? 'client',
            command: run?.command ?? null,
            title: run?.title ?? '',
            cwd: run?.cwd ?? '',
            status: run?.status ?? 'running',
            startedAt: run?.startedAt ?? null,
        },
    };
}

/**
 * The frame that closes a run.
 * @param {string} runId
 * @param {string} status
 * @param {number} [exitCode]
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function runEndedFrame(runId, status, exitCode = 0) {
    return { type: 'run.ended', runId, status, exitCode };
}

/**
 * The frame that carries one event of a run.
 * @param {string} runId
 * @param {object} event
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function runEventFrame(runId, event) {
    return { type: 'run.event', runId, event };
}

/**
 * A piece of the text of the answer.
 * @param {string} runId
 * @param {string} text
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function textDeltaFrame(runId, text) {
    return { type: 'text.delta', runId, text: textOf(text) };
}

/**
 * A piece of the thinking of the model.
 * @param {string} runId
 * @param {string} text
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function reasoningDeltaFrame(runId, text) {
    return { type: 'reasoning.delta', runId, text: textOf(text) };
}

/**
 * The frame that announces a tool.
 * @param {string} runId
 * @param {{ name: string, args?: object }} tool
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function toolExecStartFrame(runId, tool) {
    return { type: 'tool.exec.start', runId, name: tool?.name ?? null, args: tool?.args ?? {} };
}

/**
 * The frame that closes a tool.
 * @param {string} runId
 * @param {{ name: string, ok?: boolean, summary?: string, output?: string }} tool
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function toolExecDoneFrame(runId, tool) {
    return {
        type: 'tool.exec.done',
        runId,
        name: tool?.name ?? null,
        ok: tool?.ok !== false,
        summary: tool?.summary ?? '',
        output: tool?.output ?? '',
    };
}

/**
 * The frame of a warning of a run.
 * @param {string} runId
 * @param {string} message
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function warningFrame(runId, message) {
    return { type: 'warning', runId, message: textOf(message) };
}

/**
 * The frame of an error of a run.
 * @param {string} runId
 * @param {string} message
 * @param {string} [code]
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function errorEventFrame(runId, message, code = null) {
    return { type: 'error', runId, message: textOf(message), code };
}

/**
 * The frame that names a saved picture.
 * @param {string} runId
 * @param {string} path
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function imageSavedFrame(runId, path) {
    return { type: 'image.saved', runId, path: textOf(path) };
}

/**
 * The frame of the progress of a picture.
 * @param {string} runId
 * @param {string} message
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function imageProgressFrame(runId, message) {
    return { type: 'image.progress', runId, message: textOf(message) };
}

/**
 * The frame that closes the answer of the model.
 * @param {string} runId
 * @param {{ usage?: object|null, model?: string|null }} [info]
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function responseDoneFrame(runId, { usage = null, model = null } = {}) {
    return { type: 'response.done', runId, usage: usage ?? null, model: model ?? null };
}

/**
 * The frame that asks the owner of a run for a decision.
 * @param {string} runId
 * @param {string} requestId
 * @param {{ name?: string, category?: string, preview?: string }} request
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function approvalRequestFrame(runId, requestId, request) {
    return {
        type: 'approval.request',
        runId,
        requestId,
        name: request?.name ?? null,
        category: request?.category ?? null,
        preview: request?.preview ?? '',
    };
}

/**
 * The frame that asks the owner of a run a question.
 * @param {string} runId
 * @param {string} requestId
 * @param {string} question
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function questionRequestFrame(runId, requestId, question) {
    return { type: 'question.request', runId, requestId, question: textOf(question) };
}

/**
 * The answer of the completion bridge.
 * @param {string} id the id of the request
 * @param {string} text the text of the completion
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function completionFrame(id, text) {
    return { type: 'completion', id, text: textOf(text) };
}

/**
 * The frame that asks a client to run one of its own tools.
 *
 * The client answers with `tool.result`: the requestId of the frame is the key of it.
 *
 * @param {string} requestId
 * @param {string} name the name of the tool of the client, without the prefix
 * @param {object} args the arguments of the tool
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function toolCallFrame(requestId, name, args = {}) {
    return {
        type: 'tool.call',
        requestId,
        name: textOf(name),
        arguments: args && typeof args === 'object' ? args : {},
    };
}

/**
 * The answer of the server: the tools of the client are published.
 * @param {string[]} names the names of the published tools
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function toolsRegisteredFrame(names = []) {
    return { type: 'tools.registered', tools: Array.isArray(names) ? names.map(String) : [] };
}

/**
 * The lines of a file around the cursor.
 * @param {string[]} lines
 * @param {number} cursorLine
 * @param {number} above
 * @param {number} below
 * @returns {{ text: string, startLine: number, cursorLine: number }}
 * @ai.hint pure
 */
function sliceWindow(lines, cursorLine, above, below) {
    const line = Math.min(Math.max(cursorLine, 0), Math.max(0, lines.length - 1));
    const start = Math.max(0, line - above);
    const end = Math.min(lines.length - 1, line + below);
    const text = lines.slice(start, end + 1).join('\n');
    return { text, startLine: start, cursorLine: line - start };
}

/**
 * Build the request of a completion, with the window of the file.
 *
 * A small document goes whole. A big one is cut around the cursor, and the cut grows smaller
 * until the frame fits. The line of the cursor is never dropped: a request without it is
 * useless, so it is refused instead.
 * @param {{ id: string, language?: string, content?: string, cursor?: { line?: number, character?: number }, path?: string }} request
 * @param {{ maxContextBytes?: number, maxFrameBytes?: number }} [options]
 * @returns {{ frame?: object, error?: { code: string, message: string } }}
 * @exports
 * @ai.hint pure
 */
export function buildCompletionFrame(request, {
    maxContextBytes = MAX_COMPLETION_CONTEXT_BYTES,
    maxFrameBytes = MAX_COMPLETION_FRAME_BYTES,
} = {}) {
    const content = textOf(request?.content);
    const cursorLine = Number.isSafeInteger(request?.cursor?.line) ? request.cursor.line : 0;
    const character = Number.isSafeInteger(request?.cursor?.character) ? request.cursor.character : 0;

    /**
     * The frame of one window.
     * @param {{ text: string, startLine: number, cursorLine: number }} window
     * @returns {object}
     * @ai.hint pure
     */
    const frameOf = (window) => ({
        type: 'complete',
        id: request?.id ?? null,
        language: request?.language ?? null,
        content: window.text,
        cursor: { line: window.cursorLine, character },
        ...(request?.path ? { path: request.path } : {}),
    });

    const whole = { text: content, startLine: 0, cursorLine };
    if (Buffer.byteLength(content, 'utf8') <= maxContextBytes) {
        const frame = frameOf(whole);
        if (Buffer.byteLength(JSON.stringify(frame), 'utf8') <= maxFrameBytes) return { frame };
    }

    const lines = content.split('\n');
    const cursorText = lines[cursorLine] ?? '';
    if (Buffer.byteLength(cursorText, 'utf8') > maxFrameBytes) {
        return { error: { code: 'too_large', message: 'The line of the cursor is too long.' } };
    }

    for (const [above, below] of COMPLETION_WINDOWS) {
        const window = sliceWindow(lines, cursorLine, above, below);
        const frame = frameOf(window);
        if (Buffer.byteLength(JSON.stringify(frame), 'utf8') <= maxFrameBytes) return { frame };
    }
    return { error: { code: 'too_large', message: 'The completion does not fit into the frame.' } };
}
