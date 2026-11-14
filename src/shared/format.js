/**
 * @file src/shared/format.js
 * @module shared/format
 * @purpose Small formatters the tools and the answers share.
 * @depends nothing
 * @usedBy tools/filesystem, tools/terminal, tools/context, agent/roles
 * @exports formatBytes, formatDuration, truncateText, clipMiddle
 * @ai.tags format
 * @ai.hint pure
 */

/**
 * A size in bytes as a short text: `1.2 KB`, `3.4 MB`.
 * @param {number} bytes
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value < 0) return '0 B';
    if (value < 1024) return `${Math.round(value)} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = value / 1024;
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
        size /= 1024;
        index += 1;
    }
    return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[index]}`;
}

/**
 * A duration in milliseconds as a short text: `1.2 s`, `2 m 03 s`.
 * @param {number} ms
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function formatDuration(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value < 0) return '0 ms';
    if (value < 1000) return `${Math.round(value)} ms`;
    const seconds = value / 1000;
    if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 0 : 1)} s`;
    const minutes = Math.floor(seconds / 60);
    const rest = Math.round(seconds % 60);
    return `${minutes} m ${String(rest).padStart(2, '0')} s`;
}

/**
 * Cut a text to a limit and say how much was cut.
 * @param {string} text
 * @param {number} maxBytes
 * @returns {{ text: string, truncated: boolean }}
 * @exports
 * @ai.hint pure
 */
export function truncateText(text, maxBytes) {
    const value = String(text ?? '');
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return { text: value, truncated: false };
    if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { text: value, truncated: false };
    const buffer = Buffer.from(value, 'utf8');
    let end = maxBytes;
    while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
    return { text: buffer.subarray(0, end).toString('utf8'), truncated: true };
}

/**
 * Keep the head and the tail of a long text and cut the middle. Operates on UTF-8 bytes.
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function clipMiddle(text, maxBytes) {
    const data = Buffer.from(String(text ?? ''), 'utf8');
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return data.toString('utf8');
    if (data.length <= maxBytes) return data.toString('utf8');
    const half = Math.floor(maxBytes / 2);
    const head = data.subarray(0, half).toString('utf8').replace(/\uFFFD+$/, '');
    const tail = data.subarray(data.length - half).toString('utf8').replace(/^\uFFFD+/, '');
    return `${head}\n…[skipped ${formatBytes(data.length - 2 * half)}]…\n${tail}`;
}
