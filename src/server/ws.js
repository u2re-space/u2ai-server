/**
 * @file src/server/ws.js
 * @module server/ws
 * @purpose WebSocket over a Node HTTP upgrade: Node has a client and no server.
 *
 *   The transport is deliberately small. It speaks text frames, answers the pings of the
 *   client, closes a socket that stayed silent for too long, and refuses a frame bigger
 *   than the limit of the protocol. Everything else — the frames of the bus, the token,
 *   the runs — belongs to the layers above.
 *
 *   The server listens on 127.0.0.1 only: the remote stage of the plan comes later and
 *   it has to bring its own authentication.
 *
 * @depends node:http, node:events, node:crypto, shared/protocol
 * @usedBy server/serve, server/u2ai
 * @exports MAX_FRAME_BYTES, WS_GUID, acceptKey, encodeWsFrame, listenWebSocket
 * @ai.tags websocket, http
 * @ai.hint io
 */

import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { MAX_FRAME_BYTES } from '../shared/protocol.js';

export { MAX_FRAME_BYTES };

/** The magic string of the handshake (RFC 6455). */
export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** The opcodes the server uses. */
const OPCODE = Object.freeze({
    continuation: 0x0,
    text: 0x1,
    binary: 0x2,
    close: 0x8,
    ping: 0x9,
    pong: 0xa,
});

/** The close codes the server uses. */
export const CLOSE = Object.freeze({
    normal: 1000,
    away: 1001,
    protocol: 1002,
    unsupported: 1003,
    invalid: 1007,
    tooLarge: 1009,
    internal: 1011,
});

const decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Sec-WebSocket-Accept for the key of the client.
 * @param {string} key
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function acceptKey(key) {
    return createHash('sha1').update(`${String(key)}${WS_GUID}`).digest('base64');
}

/**
 * One unmasked frame of the server.
 * @param {number} opcode
 * @param {Buffer|string} payload
 * @returns {Buffer}
 * @exports
 * @ai.hint pure
 */
export function encodeWsFrame(opcode, payload) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    let header;
    if (data.length < 126) {
        header = Buffer.alloc(2);
        header[1] = data.length;
    } else if (data.length < 65536) {
        header = Buffer.alloc(4);
        header[1] = 126;
        header.writeUInt16BE(data.length, 2);
    } else {
        header = Buffer.alloc(10);
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(data.length), 2);
    }
    header[0] = 0x80 | opcode;
    return Buffer.concat([header, data]);
}

/**
 * One connection of a client.
 *
 * The connection is an event emitter: it emits `message` with the text of a frame and
 * `close` with the code the socket died with.
 *
 * @extends EventEmitter
 */
export class WsConnection extends EventEmitter {
    #socket;
    #buffer = Buffer.alloc(0);
    #alive = true;
    #lastSeen = Date.now();
    #ping = null;
    #idle = null;
    #maxFrameBytes;

    /**
     * @param {import('node:net').Socket} socket
     * @param {{ maxFrameBytes?: number, pingIntervalMs?: number, idleMs?: number }} [options]
     */
    constructor(socket, { maxFrameBytes = MAX_FRAME_BYTES, pingIntervalMs = 30_000, idleMs = 90_000 } = {}) {
        super();
        this.#socket = socket;
        this.#maxFrameBytes = maxFrameBytes;
        this.#ping = pingIntervalMs > 0
            ? setInterval(() => {
                if (this.#alive) this.#socket.write(encodeWsFrame(OPCODE.ping, Buffer.alloc(0)));
            }, pingIntervalMs)
            : null;
        this.#idle = setInterval(() => {
            if (this.#alive && Date.now() - this.#lastSeen > idleMs) this.#shutdown(CLOSE.away);
        }, Math.max(15, Math.min(idleMs, 1000)));
        this.#ping?.unref?.();
        this.#idle?.unref?.();
        socket.on('data', (chunk) => this.#onData(chunk));
        socket.on('close', () => this.#shutdown(CLOSE.internal, false));
        socket.on('error', () => this.#shutdown(CLOSE.internal, false));
    }

    /**
     * Send a text frame.
     * @param {string} text
     * @returns {void}
     * @ai.hint io
     */
    send(text) {
        if (!this.#alive) return;
        this.#socket.write(encodeWsFrame(OPCODE.text, Buffer.from(String(text), 'utf8')));
    }

    /**
     * Close the connection with a code.
     * @param {number} [code]
     * @returns {void}
     * @ai.hint io
     */
    close(code = CLOSE.normal) {
        this.#shutdown(code);
    }

    /**
     * Whether the socket is still open.
     * @returns {boolean}
     * @ai.hint pure
     */
    get alive() {
        return this.#alive;
    }

    /**
     * The code the connection died with.
     * @returns {number}
     * @ai.hint pure
     */
    get closeCode() {
        return this.closeCodeValue;
    }

    /**
     * @type {number}
     */
    closeCodeValue = CLOSE.normal;

    /**
     * Close the socket once.
     * @param {number} code
     * @param {boolean} [notify] whether the close frame goes out
     * @returns {void}
     * @ai.hint io
     */
    #shutdown(code, notify = true) {
        if (!this.#alive) return;
        this.#alive = false;
        this.closeCodeValue = code;
        if (this.#ping) clearInterval(this.#ping);
        if (this.#idle) clearInterval(this.#idle);
        if (notify) {
            const payload = Buffer.alloc(2);
            payload.writeUInt16BE(code);
            try { this.#socket.write(encodeWsFrame(OPCODE.close, payload)); } catch { /* already gone */ }
        }
        try { this.#socket.end(); } catch { /* already gone */ }
        this.emit('close', code);
    }

    /**
     * Read the frames out of the buffer.
     * @param {Buffer} chunk
     * @returns {void}
     * @ai.hint io
     */
    #onData(chunk) {
        if (!this.#alive) return;
        this.#lastSeen = Date.now();
        this.#buffer = Buffer.concat([this.#buffer, chunk]);
        for (;;) {
            if (!this.#alive || this.#buffer.length < 2) return;
            const first = this.#buffer[0];
            const second = this.#buffer[1];
            if ((first & 0x70) !== 0) return this.#fail(CLOSE.protocol);
            const fin = (first & 0x80) !== 0;
            const opcode = first & 0x0f;
            const masked = (second & 0x80) !== 0;
            let length = second & 0x7f;
            let offset = 2;
            if (length === 126) {
                if (this.#buffer.length < 4) return;
                length = this.#buffer.readUInt16BE(2);
                offset = 4;
            } else if (length === 127) {
                if (this.#buffer.length < 10) return;
                const declared = this.#buffer.readBigUInt64BE(2);
                if (declared > BigInt(this.#maxFrameBytes)) return this.#fail(CLOSE.tooLarge);
                length = Number(declared);
                offset = 10;
            }
            // A frame of a client is always masked, and this server does not assemble fragments.
            if (!masked) return this.#fail(CLOSE.protocol);
            if (!fin || opcode === OPCODE.continuation) return this.#fail(CLOSE.invalid);
            if (length > this.#maxFrameBytes) return this.#fail(CLOSE.tooLarge);
            if ((opcode & 0x8) !== 0 && length > 125) return this.#fail(CLOSE.protocol);
            const width = offset + 4 + length;
            if (this.#buffer.length < width) return;
            const mask = this.#buffer.subarray(offset, offset + 4);
            const payload = Buffer.from(this.#buffer.subarray(offset + 4, width));
            for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index & 3];
            this.#buffer = this.#buffer.subarray(width);
            if (opcode === OPCODE.text) {
                let text;
                try { text = decoder.decode(payload); } catch { return this.#fail(CLOSE.invalid); }
                this.emit('message', text);
            } else if (opcode === OPCODE.binary) {
                return this.#fail(CLOSE.unsupported);
            } else if (opcode === OPCODE.close) {
                return this.#shutdown(payload.length >= 2 ? payload.readUInt16BE(0) : CLOSE.normal);
            } else if (opcode === OPCODE.ping) {
                this.#socket.write(encodeWsFrame(OPCODE.pong, payload));
            } else if (opcode === OPCODE.pong) {
                this.#lastSeen = Date.now();
            } else {
                return this.#fail(CLOSE.protocol);
            }
        }
    }

    /**
     * Close the connection because the client broke the protocol.
     * @param {number} code
     * @returns {void}
     * @ai.hint io
     */
    #fail(code) {
        this.#shutdown(code);
    }
}

/**
 * Listen on 127.0.0.1 and accept the WebSocket upgrades.
 *
 * The HTTP requests that are not upgrades go to `onRequest`: the bridge and the tool list
 * live on the same port. `pingIntervalMs` of 0 disables the pings, `idleMs` of 0 disables
 * the idle timer.
 *
 * @param {{ port?: number, host?: string, onConnection: Function, onRequest?: Function|null,
 *           onUpgrade?: Function|null, pingIntervalMs?: number, idleMs?: number,
 *           maxFrameBytes?: number }} [options]
 * @returns {Promise<{ url: string, httpURL: string, port: number, host: string, close: () => Promise<void> }>}
 * @exports
 * @ai.hint io
 */
export function listenWebSocket({
    port = 0,
    host = '127.0.0.1',
    onConnection,
    onRequest = null,
    onUpgrade = null,
    pingIntervalMs = 30_000,
    idleMs = 90_000,
    maxFrameBytes = MAX_FRAME_BYTES,
} = {}) {
    if (host !== '127.0.0.1' && host !== 'localhost') {
        return Promise.reject(new Error('The server listens on 127.0.0.1 only.'));
    }
    if (typeof onConnection !== 'function') {
        return Promise.reject(new TypeError('The server needs a handler of the connections.'));
    }

    const sockets = new Set();
    const server = http.createServer(async (req, res) => {
        try {
            if (onRequest && (await onRequest(req, res))) return;
        } catch (error) {
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: { code: 'internal_error', message: error?.message ?? 'Server error.' } }));
            }
            return;
        }
        if (!res.headersSent) {
            res.writeHead(426, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: { code: 'upgrade_required', message: 'A WebSocket upgrade is required.' } }));
        }
    });

    server.on('upgrade', (req, socket, head) => {
        if (onUpgrade?.(req, socket, head)) return;
        const key = req.headers['sec-websocket-key'];
        const connection = String(req.headers.connection ?? '');
        if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket' || !/upgrade/i.test(connection) || !key) {
            socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
            return;
        }
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.write([
            'HTTP/1.1 101 Switching Protocols',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Accept: ${acceptKey(key)}`,
            '',
            '',
        ].join('\r\n'));
        const connection2 = new WsConnection(socket, { maxFrameBytes, pingIntervalMs, idleMs });
        onConnection(connection2, head, req);
    });

    return new Promise((resolve, reject) => {
        const onError = (error) => {
            server.removeListener('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            server.removeListener('error', onError);
            const address = server.address();
            resolve({
                url: `ws://127.0.0.1:${address.port}`,
                httpURL: `http://127.0.0.1:${address.port}`,
                port: address.port,
                host: address.address,
                close: () => new Promise((done) => {
                    for (const socket of sockets) socket.destroy();
                    sockets.clear();
                    server.close(() => done());
                    server.closeAllConnections?.();
                }),
            });
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
    });
}
