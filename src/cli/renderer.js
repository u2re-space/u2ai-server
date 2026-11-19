/**
 * @file src/cli/renderer.js
 * @module cli/renderer
 * @purpose The terminal renderer of the server: the addresses of the service and the events
 *          of the runs it serves.
 *
 *   The server is a service: it prints little and lives long. The renderer turns the events
 *   of the runs into the lines a person reads, and the machine modes of the house into json
 *   lines on stdout.
 *
 * @depends cli/colors
 * @usedBy cli, cli/worker
 * @exports detectMode, createRenderer, createPlainRenderer, eventLine
 * @ai.tags cli, renderer
 * @ai.hint keep
 */

import { COLORS, paint } from './colors.js';

/**
 * Detect the output mode of the terminal.
 * @returns {'tty'|'pipe'}
 * @exports
 * @ai.hint pure
 */
export function detectMode() {
    return process.stdout.isTTY ? 'tty' : 'pipe';
}

/**
 * The line of one event of a run.
 *
 * @param {object} event the event of the run
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function eventLine(event) {
    const type = String(event?.type ?? 'event');
    const text = event?.text ?? event?.name ?? event?.error ?? '';
    return text ? `[${type}] ${text}` : `[${type}]`;
}

/**
 * A renderer without colors, for a pipe.
 *
 * @param {{ verbose?: boolean, mode?: 'plain'|'json'|'quiet' }} opts
 * @returns {{ event: Function, line: Function, error: Function }}
 * @exports
 * @ai.hint io
 */
export function createPlainRenderer({ verbose = false, mode = 'plain' } = {}) {
    return {
        event(event) {
            if (!event || !event.type) return;
            if (mode === 'json') {
                console.log(JSON.stringify(event));
                return;
            }
            if (mode === 'quiet') return;
            console.log(eventLine(event));
        },
        line(text) {
            if (mode === 'quiet') return;
            console.log(String(text ?? ''));
        },
        error(text) {
            console.error(String(text ?? ''));
        },
    };
}

/**
 * The colored renderer for a terminal.
 *
 * @param {{ verbose?: boolean, mode?: 'plain'|'json'|'quiet' }} opts
 * @returns {{ event: Function, line: Function, error: Function }}
 * @exports
 * @ai.hint io
 */
export function createRenderer({ verbose = false, mode = 'plain' } = {}) {
    const plain = createPlainRenderer({ verbose, mode });
    return {
        event(event) {
            if (!event || !event.type) return;
            if (mode === 'json') {
                console.log(JSON.stringify(event));
                return;
            }
            if (mode === 'quiet') return;
            const line = eventLine(event);
            if (event.type === 'error') console.error(paint(line, COLORS.red));
            else if (event.type === 'warning') console.error(paint(line, COLORS.yellow));
            else console.log(paint(line, COLORS.dim));
        },
        line(text) {
            if (mode === 'quiet') return;
            console.log(paint(String(text ?? ''), COLORS.white));
        },
        error(text) {
            console.error(paint(String(text ?? ''), COLORS.red));
        },
    };
}
