/**
 * @file src/shared/protocol.js
 * @module shared/protocol
 * @purpose The constants of the `ai-serve` protocol: the frames, the commands, the limits.
 *
 * The protocol is a stream of JSON texts over a WebSocket. Two sockets speak it: the bus
 * (the runs of the agent) and the completion socket (`/v1/complete`). Both use the same
 * frames, the same limits and the same names.
 *
 * @depends nothing
 * @usedBy shared/encoder, shared/decoder, server/ws, server/u2ai, server/http, agent/autocomplete
 * @exports PROTOCOL_VERSION, MAX_FRAME_BYTES, MAX_COMPLETION_CONTEXT_BYTES,
 *          MAX_COMPLETION_FRAME_BYTES, COMPLETION_WINDOWS, COMMANDS, APPROVE_MODES, DECISIONS,
 *          START_FIELDS, REJECTED_START_FIELDS, FRAME_TYPES, EVENT_TYPES, PROCESSABLE_TOOLS,
 *          END_STATUSES, ROLES, completionWindowLines
 * @ai.tags protocol, shared
 * @ai.hint pure
 */

/** The version of the protocol. The client sends it in the `hello` frame. */
export const PROTOCOL_VERSION = '0.3';

/** Largest accepted frame. A bigger frame closes the socket with the code 1009. */
export const MAX_FRAME_BYTES = 1_048_576;

/** A document up to this size goes to the model whole. */
export const MAX_COMPLETION_CONTEXT_BYTES = 262_144;

/** A completion frame bigger than this shrinks the window of the file. */
export const MAX_COMPLETION_FRAME_BYTES = 900_000;

/**
 * The radii of the window around the cursor: the lines above and below it.
 *
 * The window shrinks when the frame does not fit: 200/50, then 100/25, 50/12, 25/6, 12/3,
 * 6/1, and at last the line of the cursor alone.
 * @type {ReadonlyArray<readonly [number, number]>}
 */
export const COMPLETION_WINDOWS = Object.freeze([
    Object.freeze([200, 50]),
    Object.freeze([100, 25]),
    Object.freeze([50, 12]),
    Object.freeze([25, 6]),
    Object.freeze([12, 3]),
    Object.freeze([6, 1]),
    Object.freeze([0, 0]),
]);

/** The commands a client may start. */
export const COMMANDS = Object.freeze(['ask', 'run', 'chat', 'image']);

/** How much the server asks before it runs a tool. */
export const APPROVE_MODES = Object.freeze(['ask', 'read', 'write', 'all']);

/** The answers of a client to a request of the server. */
export const DECISIONS = Object.freeze(['yes', 'no', 'always', 'abort']);

/** The roles of a socket. */
export const ROLES = Object.freeze(['client', 'publisher']);

/** The statuses a run may end with. */
export const END_STATUSES = Object.freeze(['completed', 'failed', 'cancelled', 'detached']);

/**
 * The fields a `start` frame may carry.
 *
 * The list is closed on purpose: a field the server does not know is a mistake of the client,
 * and a silent mistake is worse than a clear error.
 */
export const START_FIELDS = Object.freeze([
    'type', 'command', 'prompt', 'cwd', 'approve', 'effort', 'summary', 'reasoningMode', 'instructions',
    'images', 'files', 'detail', 'out', 'session', 'store', 'web', 'imagesTool', 'tools', 'noTools',
    'maxTurns', 'budgetUsd', 'budgetTokens', 'maxOutputTokens', 'temperature', 'verbosity', 'shell',
    'stream', 'size', 'complexity', 'format', 'imageBackground', 'partials', 'imageModel', 'count',
    'schema', 'role', 'single', 'team', 'memory', 'processing', 'extract', 'noExtract',
]);

/**
 * The fields of a `start` frame the server refuses by name.
 *
 * `background`, `detach` and `job` mean that the run outlives the socket that started it.
 * The bus of this server does not keep such runs: the client would wait for an answer that
 * never comes.
 */
export const REJECTED_START_FIELDS = Object.freeze(['background', 'detach', 'job']);

/** The frames a client may send. */
export const FRAME_TYPES = Object.freeze([
    'hello', 'start', 'input', 'approve', 'answer', 'complete', 'cancel', 'subscribe', 'unsubscribe', 'ping',
]);

/**
 * The events of a run.
 *
 * The names are the ones the extension reads: `text.delta` is the text of the answer,
 * `tool.exec.start` and `tool.exec.done` are the tools, `reasoning.delta` is the thinking of
 * the model, and the rest is the life of the run.
 */
export const EVENT_TYPES = Object.freeze([
    'text.delta', 'text.done', 'reasoning.delta', 'tool.exec.start', 'tool.exec.done',
    'warning', 'error', 'image.saved', 'image.progress', 'response.done',
    'approval.pending', 'question.pending', 'processing.held',
]);

/** The tools a client may hold for a run. */
export const PROCESSABLE_TOOLS = Object.freeze([
    'copy_path', 'delete_file', 'list_files', 'read_file', 'replace_text',
    'run_command', 'run_script', 'search_files', 'write_file',
]);

/**
 * The lines around the cursor for one radius of the window.
 * @param {number} radius the index in COMPLETION_WINDOWS
 * @returns {readonly [number, number]}
 * @ai.hint pure
 */
export function completionWindowLines(radius) {
    const index = Number.isSafeInteger(radius) && radius >= 0 && radius < COMPLETION_WINDOWS.length
        ? radius
        : 0;
    return COMPLETION_WINDOWS[index];
}
