/**
 * @file src/server/stdio.js
 * @module server/stdio
 * @purpose The stdio transport of the MCP server: one JSON message per line.
 *
 *   The transport knows nothing about the protocol: it reads the lines of the input,
 *   gives every line to the server and writes every answer to the output. A line that
 *   is not valid JSON is answered with the error of the parser, and the server stays
 *   alive — a broken message must not kill the session of the client.
 *
 *   The answer of a notification is nothing: the server returns `null` for it, and the
 *   transport writes nothing.
 *
 * @depends server/mcp
 * @usedBy cli
 * @exports startStdioServer
 * @ai.tags mcp, stdio, server
 * @ai.hint io
 */

import { MCP_ERROR, errorResponse } from './mcp.js';

/**
 * Run the server over stdio: one JSON message per line.
 *
 * @param {{ server: object, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream }} options
 * @returns {{ close: () => void }}
 * @exports
 * @ai.hint io
 */
export function startStdioServer({ server, input = process.stdin, output = process.stdout } = {}) {
    let buffer = '';
    let closed = false;

    /**
     * Write one answer.
     * @param {unknown} payload
     * @returns {void}
     * @ai.hint io
     */
    const write = (payload) => {
        if (closed) return;
        output.write(`${JSON.stringify(payload)}\n`);
    };

    /**
     * The answer of one line.
     * @param {string} line
     * @returns {Promise<void>}
     * @ai.hint io
     */
    const processLine = async (line) => {
        let message;
        try {
            message = JSON.parse(line);
        } catch (error) {
            write(errorResponse(null, MCP_ERROR.parse, `The message is not valid JSON: ${error.message}`));
            return;
        }
        try {
            const answer = await server.handle(message);
            if (answer) write(answer);
        } catch (error) {
            write(errorResponse(message?.id ?? null, MCP_ERROR.internal, error?.message ?? String(error)));
        }
    };

    /**
     * The answer of the data of the stream.
     * @param {Buffer|string} chunk
     * @returns {Promise<void>}
     * @ai.hint io
     */
    const onData = async (chunk) => {
        buffer += String(chunk);
        for (;;) {
            const index = buffer.indexOf('\n');
            if (index < 0) break;
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (line) await processLine(line);
        }
    };

    input.setEncoding?.('utf8');
    input.on('data', onData);
    input.resume?.();

    return {
        close() {
            if (closed) return;
            closed = true;
            input.off?.('data', onData);
            server.close?.();
        },
    };
}
