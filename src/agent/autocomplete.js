/**
 * @file src/agent/autocomplete.js
 * @module agent/autocomplete
 * @purpose The Tab-completion: the window of the document around the cursor, the prompt of
 *          the model, and the clean-up of the insertion.
 *
 *   The editor sends the whole file and the cursor. The model gets a window: the whole
 *   file when it is small, and the lines around the cursor when it is not. The window
 *   shrinks further when even it does not fit into the frame.
 *
 *   The answer of the model is not inserted as it is: the fence goes away, and the parts
 *   that the buffer already holds are dropped. What is left is the text to insert.
 *
 * @depends shared/protocol, openai/responses
 * @usedBy server/serve, server/u2ai, cli
 * @exports COMPLETION_INSTRUCTIONS, MAX_LINE_BYTES, AutocompleteError,
 *          buildCompletionContext, completionPrompt, stripCompletion,
 *          stripDoubledClosers, acceptInsertion, fitInsertion, completeAtCursor
 * @ai.tags completion, autocomplete
 * @ai.hint io
 * @ai.hint legacy-0.2 The window, the prompt and the clean-up of the insertion are
 *         ported from the monolith (`src/complete/*`) of the version 0.2.
 */

import { COMPLETION_WINDOWS, MAX_COMPLETION_CONTEXT_BYTES, MAX_COMPLETION_FRAME_BYTES } from '../shared/protocol.js';
import { parseResponse } from '../openai/responses.js';

/** A line over this size is not sent to the model: it is usually a blob, not code. */
export const MAX_LINE_BYTES = 512 * 1024;

/** The instructions of the completion: the model answers with the insertion and nothing else. */
export const COMPLETION_INSTRUCTIONS = `You are a code completion engine, like an editor inline suggestion.
The user message holds the focused file. Complete it at the | cursor.
Text before | and text after | are already in the buffer. Use the surrounding lines for the names.
Reply with only the characters to insert at |. No plan, no alternatives, no explanation.
Do not add markdown or a code fence.
Stop at the natural end of the current expression, statement, or line.
Do not repeat the characters that are already before or after |.
Do not close a bracket, a brace, or a parenthesis that already follows the cursor.`;

/**
 * A failure of the completion: the frame is too big, the cursor is not where it may be.
 */
export class AutocompleteError extends Error {
    /**
     * @param {string} code
     * @param {string} message
     */
    constructor(code, message) {
        super(message);
        this.name = 'AutocompleteError';
        this.code = code;
    }
}

/**
 * The text of the editor: the line breaks are LF and the byte-order mark is gone.
 * @param {string} text
 * @returns {string}
 * @ai.hint pure
 */
function normalizeText(text) {
    return String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * The cursor of the editor, clamped to the text.
 * @param {unknown} cursor
 * @param {string[]} lines
 * @returns {{ line: number, character: number }}
 * @ai.hint pure
 */
function readCursor(cursor, lines) {
    const line = Number.isSafeInteger(cursor?.line) && cursor.line >= 0 ? cursor.line : 0;
    const character = Number.isSafeInteger(cursor?.character) && cursor.character >= 0 ? cursor.character : 0;
    const safeLine = Math.min(line, Math.max(0, lines.length - 1));
    const safeCharacter = Math.min(character, lines[safeLine]?.length ?? 0);
    return { line: safeLine, character: safeCharacter };
}

/**
 * The lines of the window around the cursor.
 * @param {string[]} lines
 * @param {number} cursorLine
 * @param {readonly [number, number]} radius the lines above and below the cursor
 * @returns {{ start: number, end: number }}
 * @ai.hint pure
 */
function windowBounds(lines, cursorLine, radius) {
    const [above, below] = radius;
    return {
        start: Math.max(0, cursorLine - above),
        end: Math.min(lines.length - 1, cursorLine + below),
    };
}

/**
 * The window of the document that the model sees.
 *
 * A document of at most `maxContextBytes` goes whole. A bigger one goes as the lines
 * around the cursor: `line-200…line+50` at first, and less when even that does not fit
 * into `maxFrameBytes`.
 *
 * @param {{ content?: string, cursor?: { line: number, character: number }, path?: string,
 *           language?: string, maxContextBytes?: number, maxFrameBytes?: number }} input
 * @returns {{ prompt: string, focus: string, beforeCursor: string, afterCursor: string,
 *           startLine: number, cursorLine: number, truncated: boolean, radius: readonly [number, number],
 *           omittedLines: number[] }}
 * @exports
 * @ai.hint pure
 */
export function buildCompletionContext(input = {}) {
    const text = normalizeText(input.content);
    const lines = text.split('\n');
    const cursor = readCursor(input.cursor, lines);
    const maxContextBytes = Number.isSafeInteger(input.maxContextBytes) ? input.maxContextBytes : MAX_COMPLETION_CONTEXT_BYTES;
    const maxFrameBytes = Number.isSafeInteger(input.maxFrameBytes) ? input.maxFrameBytes : MAX_COMPLETION_FRAME_BYTES;

    const cursorLineText = lines[cursor.line] ?? '';
    if (Buffer.byteLength(cursorLineText, 'utf8') > MAX_LINE_BYTES) {
        throw new AutocompleteError(
            'line_too_long',
            `The line of the cursor is bigger than ${MAX_LINE_BYTES} bytes. The completion is refused.`,
        );
    }

    const whole = Buffer.byteLength(text, 'utf8') <= maxContextBytes;
    let radius = COMPLETION_WINDOWS[0];
    let bounds = whole
        ? { start: 0, end: lines.length - 1 }
        : windowBounds(lines, cursor.line, radius);
    while (!whole && Buffer.byteLength(lines.slice(bounds.start, bounds.end + 1).join('\n'), 'utf8') > maxFrameBytes) {
        const next = COMPLETION_WINDOWS.indexOf(radius) + 1;
        if (next >= COMPLETION_WINDOWS.length) break;
        radius = COMPLETION_WINDOWS[next];
        bounds = windowBounds(lines, cursor.line, radius);
    }

    const omittedLines = [];
    const rows = [];
    for (let index = bounds.start; index <= bounds.end; index += 1) {
        const line = lines[index];
        if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
            omittedLines.push(index);
            rows.push(`[line ${index + 1} omitted]`);
            continue;
        }
        if (index === cursor.line) {
            rows.push(`${line.slice(0, cursor.character)}|${line.slice(cursor.character)}`);
            continue;
        }
        rows.push(line);
    }

    const rest = cursorLineText.slice(cursor.character);
    const nextLine = lines[cursor.line + 1] ?? '';
    const beforeCursor = cursorLineText.slice(0, cursor.character);
    const afterCursor = nextLine ? `${rest}\n${nextLine}` : rest;
    const context = {
        focus: rows.join('\n'),
        beforeCursor,
        afterCursor,
        startLine: bounds.start,
        cursorLine: cursor.line,
        truncated: !whole || bounds.start > 0 || bounds.end < lines.length - 1,
        radius,
        omittedLines,
    };
    context.prompt = completionPrompt(context, input);
    return context;
}

/**
 * The prompt of the completion: the file, the cursor and the rules of the window.
 * @param {object} context the answer of `buildCompletionContext`
 * @param {{ path?: string, language?: string }} [input]
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function completionPrompt(context, input = {}) {
    const rows = [];
    rows.push(input.path ? `Focused file: ${input.path}` : 'Focused file:');
    if (input.language) rows.push(`Language: ${input.language}`);
    rows.push(`Cursor: line ${context.cursorLine + 1}.`);
    rows.push('The | marks the cursor. The text before | and the text after | are already in the buffer.');
    if (context.truncated) rows.push('The lines far from the cursor are not shown.');
    if (context.omittedLines.length) {
        rows.push(`Oversized lines omitted: ${context.omittedLines.map((line) => line + 1).join(', ')}.`);
    }
    rows.push('', context.focus);
    return rows.join('\n');
}

/**
 * Remove one wrapping code fence. The insertion itself, with its indentation, stays.
 * @param {string} text
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function stripCompletion(text) {
    const value = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const fenced = value.match(/^\s*```[^\n`]*\n([\s\S]*?)\n?```\s*$/);
    return fenced ? fenced[1] : value;
}

/**
 * The text of the cursor line before the cursor.
 * @param {string} text
 * @returns {string}
 * @ai.hint pure
 */
function cursorLineBefore(text) {
    const value = String(text ?? '');
    const at = value.lastIndexOf('\n');
    return at === -1 ? value : value.slice(at + 1);
}

/**
 * The text of the cursor line after the cursor, without the next line.
 * @param {string} text
 * @returns {string}
 * @ai.hint pure
 */
function cursorLineAfter(text) {
    const value = String(text ?? '');
    const at = value.indexOf('\n');
    return at === -1 ? value : value.slice(0, at);
}

/**
 * Drop a closing brace, bracket, or parenthesis that the buffer already holds after the
 * cursor.
 * @param {string} insertion
 * @param {string} afterCursor
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function stripDoubledClosers(insertion, afterCursor) {
    const after = String(afterCursor ?? '').replace(/^\s+/, '');
    let value = String(insertion ?? '').replace(/\r\n/g, '\n');
    if (!after) return value;
    for (const closer of ['}', ')', ']']) {
        if (!after.startsWith(closer)) continue;
        const doubled = `${closer}\n${closer}`;
        while (value.includes(doubled)) value = value.replace(doubled, closer);
        const rows = value.replace(/\n+$/, '').split('\n');
        while (rows.length > 0 && rows.at(-1).trim() === closer) rows.pop();
        if (rows.length > 0) {
            const last = rows.at(-1);
            const stripped = last.replace(new RegExp(`\\${closer}\\s*$`), '');
            if (stripped !== last) rows[rows.length - 1] = stripped.replace(/[ \t]+$/, '');
        }
        value = rows.join('\n');
    }
    return value;
}

/**
 * Drop the copy of the current line, or of the word or punctuation the cursor is on.
 * @param {string} value
 * @param {string} linePrefix
 * @returns {string}
 * @ai.hint pure
 * @ai.hint legacy-0.2
 */
function stripEchoedPrefix(value, linePrefix) {
    if (!value || !linePrefix) return value;
    if (value.startsWith(linePrefix)) return value.slice(linePrefix.length);
    const code = linePrefix.trimStart();
    if (code && value.startsWith(code)) return value.slice(code.length);
    const word = linePrefix.match(/[\w$]+$/);
    if (word && value.startsWith(word[0])) return value.slice(word[0].length);
    // `.` and the opening brackets are echoes. `+`, `=` and `|` stay: `++` and `||` are
    // still valid insertions.
    const punct = linePrefix.match(/[.,([{'"`]+$/);
    if (!punct) return value;
    const mark = punct[0];
    const max = Math.min(mark.length, value.length);
    for (let size = max; size > 0; size -= 1) {
        const echoed = mark.slice(-size);
        if (!value.startsWith(echoed)) continue;
        const next = value[size];
        if (next && echoed.endsWith(next)) continue;
        return value.slice(size);
    }
    return value;
}

/**
 * Drop the start of the suffix of the line when the insertion already ends with it.
 * @param {string} value
 * @param {string} lineSuffix
 * @returns {string}
 * @ai.hint pure
 */
function stripEchoedSuffix(value, lineSuffix) {
    if (!value || !lineSuffix) return value;
    const splitAt = value.indexOf('\n');
    const head = splitAt === -1 ? value : value.slice(0, splitAt);
    const rest = splitAt === -1 ? '' : value.slice(splitAt);
    const max = Math.min(head.length, lineSuffix.length);
    for (let size = max; size > 0; size -= 1) {
        if (head.slice(-size) === lineSuffix.slice(0, size)) return head.slice(0, -size) + rest;
    }
    return value;
}

/**
 * Drop a planning paragraph. A completion is the insertion, not an explanation of it.
 *
 * The indentation of a good insertion stays. An empty string means that nothing is shown.
 *
 * @param {string} text the text after the fence is stripped
 * @returns {string}
 * @exports
 * @ai.hint pure
 * @ai.hint legacy-0.2
 */
export function acceptInsertion(text) {
    const value = String(text ?? '');
    const sample = value.trim();
    if (!sample) return '';
    const words = sample.split(/\s+/);
    const markers = sample.match(/\b(need|likely|perhaps|should|want|infer|suggest|determine|probably)\b/gi) ?? [];
    if (markers.length >= 2 && words.length > 15) return '';
    if (/^(we|they|i|need|since|best|but|cursor)\b/i.test(sample) && words.length > 12) return '';
    if (/\bfs:(?:read|write|list)\b/.test(sample)) return '';
    return value;
}

/**
 * Keep only the characters that the buffer does not hold yet.
 *
 * An empty string means that nothing is shown.
 *
 * @param {string} insertion
 * @param {string} beforeCursor the text of the cursor line before the cursor
 * @param {string} afterCursor the text after the cursor, with the next line
 * @returns {string}
 * @exports
 * @ai.hint pure
 * @ai.hint legacy-0.2
 */
export function fitInsertion(insertion, beforeCursor, afterCursor) {
    let value = String(insertion ?? '').replace(/\r\n/g, '\n');
    if (!value) return '';
    value = stripEchoedPrefix(value, cursorLineBefore(beforeCursor));
    value = stripEchoedSuffix(value, cursorLineAfter(afterCursor));
    return stripDoubledClosers(value, afterCursor);
}

/**
 * The completion of one frame of the editor.
 *
 * The frame holds the file and the cursor: `{ id, content, cursor: { line, character } }`.
 *
 * @param {{ client: object, config?: object|null, frame: object, signal?: AbortSignal|null }} options
 * @returns {Promise<{ id: string|null, text: string, context: object, raw: object }>}
 * @exports
 * @ai.hint io
 */
export async function completeAtCursor({ client, config = null, frame = {}, signal = null } = {}) {
    if (!client?.responses?.create) throw new Error('The completion needs an API client.');
    const context = buildCompletionContext({
        content: frame.content,
        cursor: frame.cursor,
        path: frame.path,
        language: frame.language,
    });
    const raw = await client.responses.create({
        model: config?.completion?.model ?? config?.model ?? null,
        instructions: COMPLETION_INSTRUCTIONS,
        input: context.prompt,
        effort: config?.completion?.effort ?? 'low',
        signal,
    });
    const parsed = parseResponse(raw);
    const insertion = fitInsertion(
        acceptInsertion(stripCompletion(parsed.text)),
        context.beforeCursor,
        context.afterCursor,
    );
    return {
        id: typeof frame.id === 'string' ? frame.id : null,
        text: insertion,
        context,
        raw,
    };
}
