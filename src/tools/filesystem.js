/**
 * @file src/tools/filesystem.js
 * @module tools/filesystem
 * @purpose List, read, search, write, replace, delete, and copy the files of the root.
 *
 *   Every function takes the root of the run and a path relative to it. The path is
 *   resolved by `agent/access`, so no tool of this package can reach outside the root or
 *   touch a secret — the rule lives in one place.
 *
 *   The answers are plain text: the model reads them, not a program. A tool that lists a
 *   tree returns the tree; a tool that reads a file returns numbered lines.
 *
 * @depends node:path, node:fs/promises, agent/access, shared/format
 * @usedBy tools/tools, agent/roles, server/mcp
 * @exports listFiles, readTextFile, searchFiles, writeTextFile, replaceInFile, deleteFile,
 *          makeDirectory, copyPath, isBinaryFile
 * @ai.tags filesystem, tools
 * @ai.hint io
 * @ai.hint legacy-0.2
 */

import path from 'node:path';
import {
    readFile,
    writeFile,
    mkdir,
    stat,
    lstat,
    readdir,
    unlink,
    copyFile,
    cp,
    open,
} from 'node:fs/promises';
import { resolveInside, isInside, isForbiddenDirName, isProtectedFileName, NOISY_DIRS } from '../agent/access.js';
import { formatBytes } from '../shared/format.js';

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Whether the file looks binary: the first 8 KiB hold a NUL byte.
 * @param {string} abs
 * @param {number} size
 * @returns {Promise<boolean>}
 * @exports
 * @ai.hint io
 */
export async function isBinaryFile(abs, size) {
    const handle = await open(abs, 'r');
    try {
        const sample = Buffer.alloc(Math.min(8192, size));
        const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
        return sample.subarray(0, bytesRead).includes(0);
    } finally {
        await handle.close();
    }
}

/**
 * Copy the current version of a file into the backup directory before it is changed.
 * @param {string} abs
 * @param {string} rel
 * @param {string|null} backupDir
 * @returns {Promise<string|null>}
 * @ai.hint io
 */
async function backup(abs, rel, backupDir) {
    if (!backupDir) return null;
    const target = path.join(backupDir, ...rel.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    let destination = target;
    let index = 1;
    while (await stat(destination).catch(() => null)) destination = `${target}.${index++}.bak`;
    await copyFile(abs, destination);
    return destination;
}

/**
 * The nearest existing directory at or above the relative path.
 * @param {string} root
 * @param {string} rel the POSIX path relative to the root
 * @returns {Promise<string|null>}
 * @ai.hint io
 */
async function nearestDirectory(root, rel) {
    const parts = String(rel).split('/').filter((part) => part && part !== '.');
    while (parts.length) {
        parts.pop();
        const candidate = parts.join('/') || '.';
        const info = await stat(path.join(root, ...parts)).catch(() => null);
        if (info?.isDirectory()) return candidate;
    }
    return null;
}

/**
 * List a tree of directories, mark the noisy folders, and stop at the limit.
 *
 * A path that does not exist yet lists the nearest existing parent instead of failing:
 * a probe of a directory that `write_file` will create still answers with a tree.
 * @param {{ root: string, dir?: string, depth?: number, includeHidden?: boolean, maxEntries?: number }} options
 * @returns {Promise<{ text: string, count: number, truncated: boolean, missing?: string }>}
 * @exports
 * @ai.hint io
 */
export async function listFiles({ root, dir = '.', depth = 2, includeHidden = false, maxEntries = 400 }) {
    const { abs, rel } = await resolveInside(root, dir);
    const info = await stat(abs).catch(() => null);
    if (!info) {
        const parent = await nearestDirectory(root, rel);
        if (!parent) throw new Error(`The directory is not found: ${dir}`);
        const listing = await listFiles({ root, dir: parent, depth, includeHidden, maxEntries });
        const where = parent === '.' ? 'the root of the project' : `the directory ${parent}`;
        return {
            text: `The directory is not found: ${rel}. write_file will create it when it writes the file. The content of ${where}:\n${listing.text}`,
            count: listing.count,
            truncated: listing.truncated,
            missing: rel,
        };
    }
    if (!info.isDirectory()) throw new Error(`It is not a directory: ${dir}`);
    const lines = [];
    let truncated = false;

    /**
     * List one level and go deeper until the depth is reached.
     * @param {string} current
     * @param {string} prefix
     * @param {number} level
     * @returns {Promise<void>}
     * @ai.hint io
     */
    async function walk(current, prefix, level) {
        if (truncated) return;
        let entries;
        try {
            entries = await readdir(current, { withFileTypes: true });
        } catch {
            return;
        }
        entries.sort((a, b) => (a.isDirectory() === b.isDirectory()
            ? a.name.localeCompare(b.name)
            : a.isDirectory() ? -1 : 1));
        for (const entry of entries) {
            if (!includeHidden && entry.name.startsWith('.') && entry.name !== '.github') continue;
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (lines.length >= maxEntries) {
                truncated = true;
                return;
            }
            if (entry.isDirectory()) {
                const skip = NOISY_DIRS.test(entry.name);
                lines.push(`${relative}/${skip ? '  (skipped)' : ''}`);
                if (!skip && level < depth) await walk(path.join(current, entry.name), relative, level + 1);
            } else if (entry.isFile()) {
                const size = await stat(path.join(current, entry.name)).then((info2) => info2.size).catch(() => 0);
                lines.push(`${relative}  (${formatBytes(size)})`);
            } else if (entry.isSymbolicLink()) {
                lines.push(`${relative}  (symlink)`);
            }
        }
    }

    await walk(abs, rel === '.' ? '' : rel, 1);
    const note = truncated ? `\n…the list is cut (${maxEntries} entries)` : '';
    return {
        text: `${lines.join('\n') || '(empty)'}${note}`,
        count: lines.length,
        truncated,
    };
}

/**
 * Read a text file and return its numbered lines.
 * @param {{ root: string, file: string, startLine?: number|null, endLine?: number|null, maxBytes?: number }} options
 * @returns {Promise<{ text: string, totalLines: number, from: number, to: number, bytes: number, truncated: boolean }>}
 * @exports
 * @ai.hint io
 */
export async function readTextFile({ root, file, startLine = null, endLine = null, maxBytes = 256 * 1024 }) {
    const { abs, rel } = await resolveInside(root, file, { allowRoot: false });
    const info = await stat(abs).catch(() => null);
    if (!info) throw new Error(`The file is not found: ${file}`);
    if (!info.isFile()) throw new Error(`It is not a file: ${file}`);
    if (await isBinaryFile(abs, info.size)) {
        throw new Error(`The file is binary (${formatBytes(info.size)}); a picture needs the tool of the images.`);
    }
    const buffer = await readFile(abs);
    let text;
    try {
        text = utf8.decode(buffer);
    } catch {
        throw new Error(`The file ${rel} is not UTF-8.`);
    }
    const lines = text.split(/\r?\n/);
    const total = lines.length;
    const from = Math.max(1, startLine ?? 1);
    let to = Math.min(total, endLine ?? total);
    if (from > total) throw new Error(`The start_line ${from} is bigger than the number of the lines (${total}).`);
    let selected = lines.slice(from - 1, to);
    let bytes = Buffer.byteLength(selected.join('\n'));
    let truncated = false;
    while (bytes > maxBytes && selected.length > 1) {
        selected = selected.slice(0, Math.max(1, Math.floor(selected.length * (maxBytes / bytes) * 0.9)));
        bytes = Buffer.byteLength(selected.join('\n'));
        truncated = true;
        to = from + selected.length - 1;
    }
    const width = String(to).length;
    const numbered = selected.map((line, index) => `${String(from + index).padStart(width)}| ${line}`).join('\n');
    const tail = truncated ? ' (cut by the size; ask for a range)' : '';
    const header = `# ${rel} — the lines ${from}-${to} of ${total}${tail}`;
    return { text: `${header}\n${numbered}`, totalLines: total, from, to, bytes: buffer.length, truncated };
}

/**
 * Find a text in the files of the root.
 * @param {{ root: string, query: string, dir?: string, regex?: boolean, maxResults?: number,
 *           maxFileBytes?: number, includeNoisy?: boolean }} options
 * @returns {Promise<{ text: string, count: number, scanned: number, truncated: boolean }>}
 * @exports
 * @ai.hint io
 */
export async function searchFiles({
    root,
    query,
    dir = '.',
    regex = false,
    maxResults = 60,
    maxFileBytes = 1024 * 1024,
    includeNoisy = false,
}) {
    if (typeof query !== 'string' || !query) throw new Error('The query of the search is empty.');
    const { abs, rel } = await resolveInside(root, dir);
    let matcher = null;
    if (regex) {
        try {
            matcher = new RegExp(query, 'i');
        } catch (error) {
            throw new Error(`The regular expression is wrong: ${error.message}`);
        }
    }
    const results = [];
    let scanned = 0;
    let truncated = false;

    /**
     * Scan the text files under this directory until the limit of the results.
     * @param {string} current
     * @param {string} prefix
     * @returns {Promise<void>}
     * @ai.hint io
     */
    async function walk(current, prefix) {
        if (truncated) return;
        let entries;
        try {
            entries = await readdir(current, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (truncated) return;
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                if (entry.name === '.git') continue;
                if (includeNoisy ? entry.name === 'node_modules' : NOISY_DIRS.test(entry.name)) continue;
                if (isForbiddenDirName(entry.name)) continue;
                await walk(path.join(current, entry.name), relative);
            } else if (entry.isFile()) {
                if (isProtectedFileName(entry.name)) continue;
                const full = path.join(current, entry.name);
                const info = await stat(full).catch(() => null);
                if (!info || info.size > maxFileBytes) continue;
                if (await isBinaryFile(full, info.size)) continue;
                let text;
                try {
                    text = utf8.decode(await readFile(full));
                } catch {
                    continue;
                }
                scanned += 1;
                const lines = text.split(/\r?\n/);
                for (const [index, line] of lines.entries()) {
                    const hit = matcher ? matcher.test(line) : line.toLowerCase().includes(query.toLowerCase());
                    if (!hit) continue;
                    results.push(`${relative}:${index + 1}: ${line.trim().slice(0, 240)}`);
                    if (results.length >= maxResults) {
                        truncated = true;
                        break;
                    }
                }
            }
        }
    }

    await walk(abs, rel === '.' ? '' : rel);
    const note = truncated ? `\n…the results are cut (${maxResults})` : '';
    return {
        text: results.length
            ? `${results.join('\n')}${note}`
            : `Nothing was found (the files scanned: ${scanned}).`,
        count: results.length,
        scanned,
        truncated,
    };
}

/**
 * Create or overwrite a UTF-8 file, keeping the old bytes in the backup directory.
 * @param {{ root: string, file: string, content: string, overwrite?: boolean, maxBytes?: number,
 *           backupDir?: string|null }} options
 * @returns {Promise<{ rel: string, bytes: number, created: boolean, backupPath: string|null }>}
 * @exports
 * @ai.hint io
 */
export async function writeTextFile({
    root,
    file,
    content,
    overwrite = true,
    maxBytes = 4 * 1024 * 1024,
    backupDir = null,
}) {
    if (typeof content !== 'string') throw new Error('The content must be a string.');
    if (Buffer.byteLength(content) > maxBytes) throw new Error(`The content is bigger than the limit ${formatBytes(maxBytes)}.`);
    const { abs, rel } = await resolveInside(root, file, { forWrite: true, allowRoot: false });
    const existing = await stat(abs).catch(() => null);
    if (existing?.isDirectory()) throw new Error(`There is a directory on this path: ${rel}`);
    if (existing && !overwrite) throw new Error(`The file already exists: ${rel} (overwrite=false).`);
    let backupPath = null;
    if (existing?.isFile()) backupPath = await backup(abs, rel, backupDir);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
    return { rel, bytes: Buffer.byteLength(content), created: !existing, backupPath };
}

/**
 * Replace a fragment of a file: once, or everywhere when `all` is set.
 * @param {{ root: string, file: string, search: string, replacement: string, all?: boolean,
 *           maxBytes?: number, backupDir?: string|null }} options
 * @returns {Promise<{ rel: string, replacements: number, bytes: number, backupPath: string|null }>}
 * @exports
 * @ai.hint io
 */
export async function replaceInFile({
    root,
    file,
    search,
    replacement,
    all = false,
    maxBytes = 4 * 1024 * 1024,
    backupDir = null,
}) {
    if (typeof search !== 'string' || !search) throw new Error('The search must be a non-empty string.');
    if (typeof replacement !== 'string') throw new Error('The replacement must be a string.');
    const { abs, rel } = await resolveInside(root, file, { forWrite: true, allowRoot: false });
    const info = await stat(abs).catch(() => null);
    if (!info?.isFile()) throw new Error(`The file is not found: ${file}`);
    if (info.size > maxBytes) throw new Error(`The file is bigger than the limit ${formatBytes(maxBytes)}.`);
    let text;
    try {
        text = utf8.decode(await readFile(abs));
    } catch {
        throw new Error(`The file ${rel} is not UTF-8.`);
    }
    let count = 0;
    for (let index = text.indexOf(search); index !== -1; index = text.indexOf(search, index + search.length)) count += 1;
    if (count === 0) {
        const normalized = text.replaceAll('\r\n', '\n').split(search.replaceAll('\r\n', '\n')).length - 1;
        throw new Error(normalized > 0
            ? 'The fragment is not found because of the line endings (CRLF/LF); read the file again and use the exact text.'
            : 'The fragment is not found in the file; read it and use the exact text.');
    }
    if (count > 1 && !all) throw new Error(`The fragment occurs ${count} times; narrow the context or set all=true.`);
    const updated = all ? text.split(search).join(replacement) : text.replace(search, () => replacement);
    const backupPath = await backup(abs, rel, backupDir);
    await writeFile(abs, updated, 'utf8');
    return { rel, replacements: all ? count : 1, bytes: Buffer.byteLength(updated), backupPath };
}

/**
 * Copy a file into the backup directory, then delete it.
 * @param {{ root: string, file: string, backupDir?: string|null }} options
 * @returns {Promise<{ rel: string, backupPath: string|null }>}
 * @exports
 * @ai.hint io
 */
export async function deleteFile({ root, file, backupDir = null }) {
    const { abs, rel } = await resolveInside(root, file, { forWrite: true, allowRoot: false });
    const info = await stat(abs).catch(() => null);
    if (!info) throw new Error(`The file is not found: ${file}`);
    if (!info.isFile()) throw new Error('Only a file can be deleted, not a directory.');
    const backupPath = await backup(abs, rel, backupDir);
    await unlink(abs);
    return { rel, backupPath };
}

/**
 * Create a directory and the missing parents.
 * @param {{ root: string, dir: string }} options
 * @returns {Promise<{ rel: string }>}
 * @exports
 * @ai.hint io
 */
export async function makeDirectory({ root, dir }) {
    const { abs, rel } = await resolveInside(root, dir, { forWrite: true, allowRoot: false });
    await mkdir(abs, { recursive: true });
    return { rel };
}

/**
 * Copy a file or a tree, without touching the content.
 * @param {{ root: string, source: string, destination: string }} options
 * @returns {Promise<{ source: string, destination: string, type: 'file'|'directory' }>}
 * @exports
 * @ai.hint io
 */
export async function copyPath({ root, source, destination }) {
    const from = await resolveInside(root, source, { allowRoot: false });
    const to = await resolveInside(root, destination, { forWrite: true, allowRoot: false });
    const info = await lstat(from.abs).catch(() => null);
    if (!info) throw new Error(`The source is not found: ${source}`);
    if (info.isSymbolicLink()) throw new Error(`The copy of a symbolic link is denied: ${from.rel}`);
    if (!info.isFile() && !info.isDirectory()) throw new Error(`The source must be a file or a directory: ${from.rel}`);
    const target = path.resolve(to.abs);
    if (info.isDirectory() && isInside(from.abs, target)) throw new Error('A directory cannot be copied into itself.');

    /**
     * Check the tree: no secret, no forbidden directory, no symbolic link.
     * @param {string} abs
     * @param {string} rel
     * @returns {Promise<void>}
     * @ai.hint io
     */
    async function validateTree(abs, rel) {
        const current = await lstat(abs);
        const name = path.basename(abs);
        if (isForbiddenDirName(name)) throw new Error(`The access is denied: ${rel}`);
        if (current.isSymbolicLink()) throw new Error(`The copy of a symbolic link is denied: ${rel}`);
        if (current.isFile() && isProtectedFileName(name)) throw new Error(`The file with the secret is not accessible: ${rel}`);
        if (current.isDirectory()) {
            for (const entry of await readdir(abs, { withFileTypes: true })) {
                await validateTree(path.join(abs, entry.name), `${rel}/${entry.name}`);
            }
        } else if (!current.isFile()) {
            throw new Error(`The type of the file is not supported: ${rel}`);
        }
    }

    await validateTree(from.abs, from.rel);
    const targetInfo = await lstat(to.abs).catch(() => null);
    if (targetInfo) throw new Error(`The path of the destination already exists: ${to.rel}`);
    await mkdir(path.dirname(to.abs), { recursive: true });
    await cp(from.abs, to.abs, { recursive: true, errorOnExist: true, force: false, dereference: false });
    return { source: from.rel, destination: to.rel, type: info.isDirectory() ? 'directory' : 'file' };
}
