/**
 * @file src/server/u2ai.js
 * @module server/u2ai
 * @purpose The hub of the bus: the runs, the subscribers, the approvals and the questions.
 *
 *   The bus is a stream of frames over one WebSocket. A client says `hello` with the token
 *   of the server, starts a run with `start`, and reads the life of the run: `run.started`,
 *   `run.event` for every event of the run, and `run.ended` when it is over.
 *
 *   Two kinds of the events need the client: the approval of a tool and the question of
 *   the model. The hub asks the owner of the run and waits for the answer; the wait ends
 *   when the run ends, when the socket dies, or when the signal of the run is aborted.
 *
 *   The hub knows nothing about the work itself: the runner is plugged in by the caller,
 *   and the hub only keeps the bookkeeping of the runs.
 *
 *   A client may hold a tool of a run for itself: it sends `processing.claim`, and the
 *   server asks that client to run the tool with `tool.request` instead of running it.
 *   The client answers with `tool.result`.
 *
 *   A client may also publish the tools of its own — the file system of the editor, the
 *   terminal of the editor — with `tools.register`. The server keeps the catalog of every
 *   client, and `callClientTool` asks the owner of a tool to run it.
 *
 * @depends node:crypto, shared/protocol, shared/decoder, shared/encoder
 * @usedBy server/serve, cli
 * @exports createHub, attachConnection, attachCompletionSocket
 * @ai.tags websocket, runs, hub
 * @ai.hint io
 */

import { randomUUID } from 'node:crypto';
import { COMMANDS, FRAME_TYPES, DECISIONS, PROTOCOL_VERSION, TOOL_REQUEST_TIMEOUT_MS, CLIENT_TOOL_SEPARATOR } from '../shared/protocol.js';
import { validateFrame, validateStart, decodeFrame } from '../shared/decoder.js';
import { executeToolRequest } from '../tools/tools.js';
import {
    errorFrame,
    encodeFrame,
    readyFrame,
    runStartedFrame,
    runEndedFrame,
    runEventFrame,
    approvalRequestFrame,
    questionRequestFrame,
    toolCallFrame,
    toolsRegisteredFrame,
} from '../shared/encoder.js';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The error of an aborted run.
 * @returns {Error}
 * @ai.hint pure
 */
function abortError() {
    const error = new Error('The run was aborted.');
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    return error;
}

/**
 * The run as the clients see it.
 * @param {object} run
 * @returns {object}
 * @ai.hint pure
 */
function publicRun(run) {
    return {
        id: run.id,
        source: run.source,
        command: run.command,
        title: run.title,
        cwd: run.cwd,
        status: run.status,
        startedAt: run.startedAt,
    };
}

/**
 * Create the hub of the bus.
 *
 * @param {{ token: string, onStart?: Function, onComplete?: Function|null,
 *           toolTimeoutMs?: number, createId?: () => string, now?: () => string }} options
 * @returns {object}
 * @exports
 * @ai.hint io
 */
export function createHub({
    token,
    onStart = async () => {},
    onComplete = null,
    toolTimeoutMs = TOOL_REQUEST_TIMEOUT_MS,
    createId = () => randomUUID(),
    now = () => new Date().toISOString(),
} = {}) {
    /** @type {Map<string, object>} */
    const sockets = new Map();
    /** @type {Map<string, object>} */
    const runs = new Map();
    /** @type {Map<string, { runId: string, ownerId: string, kind: string, resolve: Function }>} */
    const pending = new Map();
    /** @type {Map<string, Array<{ name: string, description: string, parameters: object, client: string, tool: string }>>} */
    const clientTools = new Map();

    /**
     * Send a frame to one socket. A broken socket never breaks the hub.
     * @param {object} socket
     * @param {object} frame
     * @returns {void}
     * @ai.hint pure
     */
    const send = (socket, frame) => {
        try { socket.send(frame); } catch { /* the socket is gone */ }
    };

    /**
     * Send a frame to the sockets that pass the test.
     * @param {object} frame
     * @param {(socket: object) => boolean} [include]
     * @returns {void}
     * @ai.hint pure
     */
    const broadcast = (frame, include = (socket) => socket.authed) => {
        for (const socket of sockets.values()) if (include(socket)) send(socket, frame);
    };

    /**
     * Publish one event of a run to the subscribers of the run.
     * @param {string} runId
     * @param {object} event
     * @returns {void}
     * @ai.hint pure
     */
    function publish(runId, event) {
        const frame = runEventFrame(runId, event);
        broadcast(frame, (socket) => socket.authed && (socket.all || socket.subs.has(runId)));
    }

    /**
     * Open a run.
     * @param {object} socket
     * @param {{ source?: string, command?: string, title?: string, cwd?: string, prompt?: string }} fields
     * @returns {object}
     * @ai.hint pure
     */
    function openRun(socket, fields) {
        const run = {
            id: createId(),
            ownerId: socket.id,
            status: 'running',
            startedAt: now(),
            controller: new AbortController(),
            queue: [],
            waiters: [],
            holders: new Map(),
            source: 'client',
            command: null,
            title: '',
            cwd: '',
            prompt: '',
            ...fields,
        };
        runs.set(run.id, run);
        return run;
    }

    /**
     * The runs that are still going.
     * @returns {object[]}
     * @ai.hint pure
     */
    const runningRuns = () => [...runs.values()].filter((run) => run.status === 'running').map(publicRun);

    /**
     * End a run and release everything that waits for it.
     * @param {string} runId
     * @param {string} status
     * @param {number} [exitCode]
     * @returns {void}
     * @ai.hint pure
     */
    function finish(runId, status, exitCode = 0) {
        const run = runs.get(runId);
        if (!run || run.status !== 'running') return;
        run.status = status;
        broadcast(runEndedFrame(runId, status, exitCode));
        const waiters = run.waiters;
        run.waiters = [];
        for (const waiter of waiters) waiter.reject(abortError());
        for (const [requestId, item] of [...pending]) {
            if (item.runId !== runId) continue;
            if (item.kind === 'approval') item.resolve('abort');
            else if (item.kind === 'question') item.resolve(null);
            else if (item.kind === 'tool') item.resolve(new Error('The run is over.'));
            pending.delete(requestId);
        }
        runs.delete(runId);
    }

    /**
     * Wait for the answer of the client: an approval or a question.
     * @param {string} runId
     * @param {'approval'|'question'} kind
     * @param {AbortSignal|undefined} signal
     * @param {*} aborted the answer of a run that ends
     * @param {(requestId: string) => void} notify
     * @returns {Promise<*>}
     * @ai.hint pure
     */
    function waitControl(runId, kind, signal, aborted, notify) {
        const run = runs.get(runId);
        if (!run || signal?.aborted) return Promise.resolve(aborted);
        const requestId = createId();
        return new Promise((resolve) => {
            /**
             * @param {*} value
             * @returns {void}
             * @ai.hint pure
             */
            const done = (value) => {
                pending.delete(requestId);
                signal?.removeEventListener('abort', onAbort);
                resolve(value);
            };
            /**
             * @returns {void}
             * @ai.hint pure
             */
            const onAbort = () => done(aborted);
            pending.set(requestId, { runId, ownerId: run.ownerId, kind, resolve: done });
            if (signal) signal.addEventListener('abort', onAbort, { once: true });
            notify(requestId);
        });
    }

    /**
     * Ask the owner of a run for the permission of a tool.
     * @param {string} runId
     * @param {{ name?: string, category?: string, preview?: string }} request
     * @param {AbortSignal} [signal]
     * @returns {Promise<'yes'|'no'|'always'|'abort'>}
     * @ai.hint pure
     */
    function requestApproval(runId, request, signal) {
        return waitControl(runId, 'approval', signal, 'abort', (requestId) => {
            publish(runId, { type: 'approval.pending', name: request?.name ?? null, category: request?.category ?? null });
            const run = runs.get(runId);
            const owner = run ? sockets.get(run.ownerId) : null;
            owner?.send(approvalRequestFrame(runId, requestId, request ?? {}));
        });
    }

    /**
     * Ask the owner of a run a question.
     * @param {string} runId
     * @param {string} question
     * @param {AbortSignal} [signal]
     * @returns {Promise<string|null>}
     * @ai.hint pure
     */
    function requestQuestion(runId, question, signal) {
        return waitControl(runId, 'question', signal, null, (requestId) => {
            publish(runId, { type: 'question.pending', question: String(question ?? '') });
            const run = runs.get(runId);
            const owner = run ? sockets.get(run.ownerId) : null;
            owner?.send(questionRequestFrame(runId, requestId, question));
        });
    }

    /**
     * Wait for the next line of the owner of a run.
     * @param {string} runId
     * @param {AbortSignal} [signal]
     * @returns {Promise<string>}
     * @ai.hint pure
     */
    function waitInput(runId, signal) {
        const run = runs.get(runId);
        if (!run) return Promise.reject(abortError());
        if (run.queue.length) return Promise.resolve(run.queue.shift());
        return new Promise((resolve, reject) => {
            /**
             * @param {Error} error
             * @returns {void}
             * @ai.hint pure
             */
            const fail = (error) => {
                run.waiters = run.waiters.filter((item) => item.reject !== fail);
                signal?.removeEventListener('abort', onAbort);
                reject(error);
            };
            /**
             * @returns {void}
             * @ai.hint pure
             */
            const onAbort = () => fail(abortError());
            run.waiters.push({
                resolve: (text) => { signal?.removeEventListener('abort', onAbort); resolve(text); },
                reject: fail,
            });
            if (signal) signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    /**
     * Attach a client to the bus.
     * @param {{ send: Function, close: Function }} transport
     * @returns {object} the socket of the hub
     * @ai.hint io
     */
    function connect(transport) {
        const socket = {
            id: randomUUID(),
            send: (frame) => transport.send(frame),
            close: (code) => transport.close(code),
            role: null,
            name: null,
            authed: false,
            subs: new Set(),
            all: false,
        };
        sockets.set(socket.id, socket);
        return socket;
    }

    /**
     * A client is gone: the runs it owned end, the runs it watched go on.
     * @param {object} socket
     * @returns {void}
     * @ai.hint pure
     */
    function disconnect(socket) {
        sockets.delete(socket.id);
        clientTools.delete(socket.id);
        for (const [requestId, item] of [...pending]) {
            if (item.kind !== 'tool' && item.kind !== 'client-tool') continue;
            if (item.holderId !== socket.id) continue;
            item.resolve(new Error('The holder of the tool is gone.'));
            pending.delete(requestId);
        }
        for (const run of [...runs.values()]) {
            if (run.status !== 'running') continue;
            if (run.ownerId !== socket.id) continue;
            run.controller?.abort();
            finish(run.id, 'cancelled', 130);
        }
    }

    /**
     * End every run: the server is stopping.
     * @returns {void}
     * @ai.hint pure
     */
    function shutdown() {
        for (const run of [...runs.values()]) {
            if (run.status !== 'running') continue;
            run.controller?.abort();
            finish(run.id, 'cancelled', 130);
        }
    }

    /**
     * The run of the frame, when the socket owns it.
     * @param {object} socket
     * @param {unknown} runId
     * @returns {object|null}
     * @ai.hint pure
     */
    function owned(socket, runId) {
        const run = typeof runId === 'string' ? runs.get(runId) : null;
        if (!run || run.status !== 'running') {
            send(socket, errorFrame('unknown_run', 'The run is unknown or already finished.'));
            return null;
        }
        if (run.ownerId !== socket.id) {
            send(socket, errorFrame('not_owner', 'Only the owner of the run may send this frame.'));
            return null;
        }
        return run;
    }

    /**
     * Start a run.
     * @param {object} socket
     * @param {object} frame
     * @returns {void}
     * @ai.hint io
     */
    function start(socket, frame) {
        const checked = validateStart(frame);
        if (!checked.ok) {
            send(socket, errorFrame(checked.code, checked.message));
            return;
        }
        const prompt = typeof frame.prompt === 'string' ? frame.prompt : '';
        const run = openRun(socket, {
            source: 'client',
            command: frame.command,
            title: `${frame.command} ${prompt}`.trim().slice(0, 200),
            cwd: typeof frame.cwd === 'string' ? frame.cwd : '',
            prompt,
        });
        socket.subs.add(run.id);
        broadcast(runStartedFrame(publicRun(run)));
        if (frame.command === 'chat' && prompt.trim()) run.queue.push(prompt);
        void Promise.resolve(onStart(run, frame)).catch((error) => {
            publish(run.id, { type: 'warning', message: error?.message ?? String(error) });
            finish(run.id, 'failed', error?.exitCode ?? 1);
        });
    }

    /**
     * Read one frame of a client.
     * @param {object} socket
     * @param {object} frame
     * @returns {Promise<void>}
     * @ai.hint io
     */
    async function receive(socket, frame) {
        if (!isRecord(frame) || typeof frame.type !== 'string') {
            send(socket, errorFrame('bad_request', 'The frame must be a JSON object.'));
            return;
        }
        if (!socket.authed) {
            if (frame.type !== 'hello') {
                send(socket, errorFrame('unauthorized', 'Send hello with the token first.'));
                socket.close(1008);
                return;
            }
            if (frame.token !== token) {
                send(socket, errorFrame('unauthorized', 'The token is wrong.'));
                socket.close(1008);
                return;
            }
            if (frame.role !== 'client') {
                send(socket, errorFrame('bad_request', 'The role of this bus is client.'));
                socket.close(1008);
                return;
            }
            socket.authed = true;
            socket.role = 'client';
            const asked = typeof frame.name === 'string' ? frame.name.trim() : '';
            socket.name = asked ? asked.slice(0, 40) : `client-${socket.id.slice(0, 8)}`;
            const ready = readyFrame(runningRuns());
            ready.protocol = PROTOCOL_VERSION;
            send(socket, ready);
            return;
        }
        if (frame.type === 'hello') {
            send(socket, errorFrame('conflict', 'The hello frame was already sent.'));
            return;
        }
        const checked = validateFrame(frame);
        if (!checked.ok) {
            send(socket, errorFrame(checked.code, checked.message));
            return;
        }
        switch (frame.type) {
            case 'start':
                return start(socket, frame);
            case 'subscribe':
                return subscribe(socket, frame.runId, true);
            case 'unsubscribe':
                return subscribe(socket, frame.runId, false);
            case 'cancel': {
                const run = owned(socket, frame.runId);
                if (!run) return;
                run.controller?.abort();
                finish(run.id, 'cancelled', 130);
                return;
            }
            case 'input': {
                const run = owned(socket, frame.runId);
                if (!run) return;
                const text = typeof frame.text === 'string' ? frame.text : '';
                const waiter = run.waiters.shift();
                if (waiter) waiter.resolve(text);
                else run.queue.push(text);
                return;
            }
            case 'approve':
            case 'answer':
                return control(socket, frame);
            case 'processing.claim':
                return claim(socket, frame);
            case 'tool.result':
                return toolResult(socket, frame);
            case 'tools.register':
                return registerTools(socket, frame);
            case 'complete':
                if (!onComplete) {
                    send(socket, errorFrame('not_ready', 'The completion bridge is not running yet.'));
                    return;
                }
                try {
                    const answer = await onComplete(frame);
                    send(socket, { type: 'completion', id: frame.id, text: String(answer?.text ?? answer ?? '') });
                } catch (error) {
                    send(socket, errorFrame('completion_failed', error?.message ?? 'The completion failed.'));
                }
                return;
            case 'ping':
                send(socket, { type: 'pong', id: frame.id ?? null });
                return;
            default:
                send(socket, errorFrame('unknown_type', `Unknown frame type: ${frame.type}.`));
        }
    }

    /**
     * Subscribe a client to a run, or to every run.
     * @param {object} socket
     * @param {unknown} runId
     * @param {boolean} on
     * @returns {void}
     * @ai.hint pure
     */
    function subscribe(socket, runId, on) {
        if (runId === '*') {
            socket.all = on;
            return;
        }
        if (typeof runId !== 'string' || !runs.has(runId)) {
            send(socket, errorFrame('unknown_run', 'The run is unknown or already finished.'));
            return;
        }
        if (on) socket.subs.add(runId);
        else socket.subs.delete(runId);
    }

    /**
     * The names of the tools that the sockets hold for the run.
     * @param {object} run
     * @returns {string[]}
     * @ai.hint pure
     */
    function heldTools(run) {
        return [...run.holders.keys()].sort();
    }

    /**
     * A socket holds the tools of a run for itself.
     *
     * The tools that another socket held and this socket takes are released: that socket
     * gets `processing.released`. The socket that claimed gets `processing.claimed`, and
     * the run publishes `processing.held` with the names of the tools that are held.
     *
     * @param {object} socket
     * @param {object} frame
     * @returns {void}
     * @ai.hint pure
     */
    function claim(socket, frame) {
        const run = typeof frame.runId === 'string' ? runs.get(frame.runId) : null;
        if (!run || run.status !== 'running') {
            send(socket, errorFrame('unknown_run', 'The run is unknown or already finished.'));
            return;
        }
        const tools = Array.isArray(frame.tools) ? frame.tools.map(String) : [];
        const next = new Set(tools);
        /** @type {Map<string, string[]>} */
        const released = new Map();
        for (const [name, holderId] of [...run.holders.entries()]) {
            const mine = holderId === socket.id;
            if (mine && !next.has(name)) run.holders.delete(name);
            if (!mine && next.has(name)) {
                run.holders.delete(name);
                const names = released.get(holderId) ?? [];
                names.push(name);
                released.set(holderId, names);
            }
        }
        for (const name of tools) run.holders.set(name, socket.id);
        for (const [holderId, names] of released) {
            sockets.get(holderId)?.send({ type: 'processing.released', runId: run.id, tools: names.sort() });
        }
        socket.send({ type: 'processing.claimed', runId: run.id, tools: [...tools] });
        publish(run.id, { type: 'processing.held', tools: heldTools(run) });
    }

    /**
     * Ask the holder of a tool to run it.
     *
     * A tool that nobody holds is not a request: the answer is `null`, and the caller
     * runs the tool itself. A holder that does not answer in time is a failure: the run
     * goes on without the tool.
     *
     * @param {string} runId
     * @param {string} name
     * @param {object} args
     * @param {{ signal?: AbortSignal|null, timeoutMs?: number }} [options]
     * @returns {Promise<{ output: string, summary: string, changes: object[] }|null>}
     * @ai.hint pure
     */
    function requestTool(runId, name, args = {}, { signal = null, timeoutMs = toolTimeoutMs } = {}) {
        if (signal?.aborted) return Promise.reject(abortError());
        const run = runs.get(runId);
        if (!run || run.status !== 'running') {
            return Promise.reject(new Error('The run is unknown or already finished.'));
        }
        const holderId = run.holders.get(name);
        if (!holderId) return Promise.resolve(null);
        const holder = sockets.get(holderId);
        if (!holder) return Promise.reject(new Error('The holder of the tool is gone.'));
        const requestId = createId();
        return new Promise((resolve, reject) => {
            let settled = false;
            /**
             * @param {Error|null} error
             * @param {object} [value]
             * @returns {void}
             * @ai.hint pure
             */
            const done = (error, value) => {
                if (settled) return;
                settled = true;
                pending.delete(requestId);
                signal?.removeEventListener('abort', onAbort);
                clearTimeout(timer);
                if (error) reject(error);
                else resolve(value);
            };
            /** @returns {void} */
            const onAbort = () => done(abortError());
            const timer = setTimeout(() => {
                done(new Error(`The holder of the tool ${name} did not answer in time.`));
            }, timeoutMs);
            timer.unref?.();
            pending.set(requestId, { runId, holderId, kind: 'tool', resolve: done });
            if (signal) signal.addEventListener('abort', onAbort, { once: true });
            holder.send({ type: 'tool.request', runId, requestId, name, args });
        });
    }

    /**
     * A client publishes the tools of its own.
     *
     * The list of the socket replaces the list it had before: a client that changes its
     * catalog publishes it again. The names of the tools carry the name of the client, so
     * two clients may have a tool with the same name.
     *
     * @param {object} socket
     * @param {object} frame
     * @returns {void}
     * @ai.hint pure
     */
    function registerTools(socket, frame) {
        const client = socket.name || `client-${socket.id.slice(0, 8)}`;
        const tools = [];
        for (const tool of Array.isArray(frame.tools) ? frame.tools : []) {
            const name = String(tool?.name ?? '').trim();
            if (!name) continue;
            tools.push({
                name: `${client}${CLIENT_TOOL_SEPARATOR}${name}`,
                description: typeof tool?.description === 'string' ? tool.description : '',
                parameters: isRecord(tool?.parameters)
                    ? tool.parameters
                    : { type: 'object', properties: {} },
                client,
                tool: name,
            });
        }
        clientTools.set(socket.id, tools);
        send(socket, toolsRegisteredFrame(tools.map((tool) => tool.name)));
    }

    /**
     * The tools of the clients of the bus.
     *
     * The list is the catalog of the editors: the MCP server publishes it, and the model
     * may call any tool of it.
     *
     * @returns {Array<{ name: string, description: string, parameters: object, client: string, tool: string }>}
     * @exports
     * @ai.hint pure
     */
    function listClientTools() {
        const out = [];
        for (const list of clientTools.values()) out.push(...list);
        return out;
    }

    /**
     * Call a tool of a client.
     *
     * The client owns the tool, so the client runs it: the server only waits for the
     * answer. A client that does not answer in time is a failure — the caller decides
     * what to do with it.
     *
     * @param {string} name the name of the tool, with the prefix of the client
     * @param {object} [args]
     * @param {{ timeoutMs?: number }} [options]
     * @returns {Promise<{ ok: boolean, output: string, summary: string, changes: object[], error: string|null }>}
     * @ai.hint pure
     */
    function callClientTool(name, args = {}, { timeoutMs = toolTimeoutMs } = {}) {
        const wanted = String(name ?? '');
        let owner = null;
        let found = null;
        for (const [socketId, list] of clientTools) {
            const tool = list.find((item) => item.name === wanted);
            if (!tool) continue;
            owner = sockets.get(socketId) ?? null;
            found = tool;
            break;
        }
        if (!found) return Promise.reject(new Error(`There is no client tool named ${wanted}.`));
        if (!owner) return Promise.reject(new Error(`The client of the tool ${wanted} is gone.`));
        const requestId = createId();
        return new Promise((resolve, reject) => {
            let settled = false;
            /**
             * @param {Error|null} error
             * @param {object} [value]
             * @returns {void}
             * @ai.hint pure
             */
            const done = (error, value) => {
                if (settled) return;
                settled = true;
                pending.delete(requestId);
                clearTimeout(timer);
                if (error) reject(error);
                else resolve(value);
            };
            /** @returns {void} */
            const timer = setTimeout(() => {
                done(new Error(`The client of the tool ${wanted} did not answer in time.`));
            }, timeoutMs);
            timer.unref?.();
            pending.set(requestId, { runId: null, holderId: owner.id, kind: 'client-tool', resolve: done });
            send(owner, toolCallFrame(requestId, found.tool, args));
        });
    }

    /**
     * The answer of the holder of a tool.
     * @param {object} socket
     * @param {object} frame
     * @returns {void}
     * @ai.hint pure
     */
    function toolResult(socket, frame) {
        const item = typeof frame.requestId === 'string' ? pending.get(frame.requestId) : null;
        if (!item || (item.kind !== 'tool' && item.kind !== 'client-tool')) {
            send(socket, errorFrame('bad_request', 'The requestId is unknown.'));
            return;
        }
        if (item.holderId !== socket.id) {
            send(socket, errorFrame('bad_request', 'This requestId belongs to another socket.'));
            return;
        }
        if (typeof frame.error === 'string' && frame.error.trim()) {
            item.resolve(new Error(frame.error));
            return;
        }
        item.resolve(null, {
            output: typeof frame.output === 'string' ? frame.output : '',
            summary: typeof frame.summary === 'string' ? frame.summary : '',
            changes: Array.isArray(frame.changes) ? frame.changes : [],
        });
    }

    /**
     * Run a tool of a run: the holder runs it, or the server does.
     *
     * The permission of the user is asked only when the server runs the tool itself: a
     * holder of the extension has already asked its own user.
     *
     * @param {string} runId
     * @param {string} name
     * @param {object} args
     * @param {{ root?: string, config?: object|null, signal?: AbortSignal|null, approve?: string,
     *           timeoutMs?: number }} [options]
     * @returns {Promise<{ ok: boolean, output: string, summary: string,
     *           changes: object[], error: string|null }>}
     * @ai.hint pure
     */
    async function runTool(runId, name, args = {}, {
        root = null,
        config = null,
        signal = null,
        approve = 'ask',
        timeoutMs = toolTimeoutMs,
    } = {}) {
        const answer = await requestTool(runId, name, args, { signal, timeoutMs });
        if (answer) return { ok: true, error: null, ...answer };
        const approveFn = async (request) => {
            const decision = await requestApproval(runId, request, signal);
            return decision === 'yes' || decision === 'always';
        };
        return await executeToolRequest(name, args, { root, config, signal, approve, approveFn });
    }

    /**
     * The answer of the client to an approval or to a question.
     * @param {object} socket
     * @param {object} frame
     * @returns {void}
     * @ai.hint pure
     */
    function control(socket, frame) {
        const item = typeof frame.requestId === 'string' ? pending.get(frame.requestId) : null;
        if (!item) {
            send(socket, errorFrame('bad_request', 'The requestId is unknown.'));
            return;
        }
        if (item.ownerId !== socket.id) {
            send(socket, errorFrame('not_owner', 'Only the owner of the run may send this frame.'));
            return;
        }
        if (frame.type === 'approve') {
            if (!DECISIONS.includes(frame.decision)) {
                send(socket, errorFrame('bad_request', `The decision must be one of: ${DECISIONS.join(', ')}.`));
                return;
            }
            item.resolve(frame.decision);
            return;
        }
        item.resolve(typeof frame.text === 'string' ? frame.text : '');
    }

    return {
        connect,
        receive,
        disconnect,
        publish,
        requestApproval,
        requestQuestion,
        requestTool,
        runTool,
        listClientTools,
        callClientTool,
        waitInput,
        finish,
        shutdown,
        runs,
        sockets,
        commands: COMMANDS,
    };
}

/**
 * Attach one socket of the server to the hub.
 *
 * The frames of the client are read one at a time: a frame that does not parse is answered
 * with an error, and the socket goes on.
 * @param {object} hub the hub of `createHub`
 * @param {import('./ws.js').WsConnection} connection
 * @returns {object} the socket of the hub
 * @exports
 * @ai.hint io
 */
export function attachConnection(hub, connection) {
    const socket = hub.connect({
        send(frame) {
            try {
                connection.send(encodeFrame(frame));
            } catch {
                // A frame that does not fit is dropped: the run goes on without it.
            }
        },
        close(code) {
            connection.close(code);
        },
    });
    connection.on('message', (text) => {
        const answer = decodeFrame(text);
        if (!answer.ok) {
            socket.send(errorFrame(answer.code, answer.message));
            return;
        }
        void Promise.resolve(hub.receive(socket, answer.frame)).catch(() => {});
    });
    connection.on('close', () => hub.disconnect(socket));
    return socket;
}

/**
 * Attach one socket to the bridge of the completion.
 *
 * The socket of the completion is not a client of the bus: it does not say `hello` and it
 * does not start runs. It sends `complete` frames and reads the answer of the model. The
 * token of the server is checked by the caller, before the socket is attached — the token
 * travels in the query of the upgrade.
 *
 * @param {import('./ws.js').WsConnection} connection
 * @param {{ onComplete: Function }} options
 * @returns {void}
 * @exports
 * @ai.hint io
 */
export function attachCompletionSocket(connection, { onComplete } = {}) {
    /**
     * Send one frame of the bridge.
     * @param {object} frame
     * @returns {void}
     * @ai.hint pure
     */
    const send = (frame) => {
        try { connection.send(encodeFrame(frame)); } catch { /* the socket is gone */ }
    };

    connection.on('message', (text) => {
        const answer = decodeFrame(text);
        if (!answer.ok) {
            send(errorFrame(answer.code, answer.message));
            return;
        }
        const frame = answer.frame;
        if (frame.type !== 'complete') {
            send(errorFrame('bad_request', 'The completion socket takes complete frames only.'));
            return;
        }
        if (typeof onComplete !== 'function') {
            send(errorFrame('not_ready', 'The completion bridge is not running yet.'));
            return;
        }
        void Promise.resolve(onComplete(frame))
            .then((result) => {
                send({
                    type: 'completion',
                    id: typeof frame.id === 'string' ? frame.id : null,
                    text: String(result?.text ?? result ?? ''),
                });
            })
            .catch((error) => {
                send(errorFrame('completion_failed', error?.message ?? 'The completion failed.'));
            });
    });
}
