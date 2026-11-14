/**
 * @file src/agent/access.js
 * @module agent/access
 * @purpose Keep the paths of the model inside the root of the run and away from the secrets.
 *
 *   The model names paths; the server touches the disk. Between those two there is this
 *   module: it turns a relative path into an absolute one, refuses the paths that leave
 *   the root (through `..` or through a symbolic link), refuses the secret files and the
 *   secret directories, and refuses the writes into the read-only directories.
 *
 *   The rules are the same for every tool, so a new tool cannot open a hole by accident:
 *   it has to go through `resolveInside`.
 *
 * @depends node:path, node:fs/promises
 * @usedBy tools/filesystem, tools/terminal, tools/context, agent/roles
 * @exports NOISY_DIRS, isProtectedFileName, isForbiddenDirName, toPosix, isInside,
 *          resolveInside, createAccess
 * @ai.tags paths, sandbox
 * @ai.hint io
 * @ai.hint legacy-0.2
 */

import path from 'node:path';
import { realpath, lstat } from 'node:fs/promises';

/** Names that are never readable or writable: the secrets and the keys. */
const PROTECTED_FILES = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx|jks|keystore))$/i;

/** The directories that are never accessible at all. */
const FORBIDDEN_DIRS = /^(?:\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker)$/i;

/** The directories that are skipped by the listing and the search. */
export const NOISY_DIRS = /^(?:\.git|node_modules|\.hg|\.svn|dist|build|coverage|\.next|\.nuxt|\.cache|\.venv|venv|__pycache__|target|\.ai-agent|\.backup)$/i;

/** The directories that may be read, but never written. */
const READ_ONLY_DIRS = /^(?:\.git|node_modules)$/i;

/**
 * Whether the name is a secret or a key file.
 * @param {string} name the name of the file, not a path
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function isProtectedFileName(name) {
    return PROTECTED_FILES.test(String(name ?? ''));
}

/**
 * Whether the name is a directory the model must never enter.
 * @param {string} name
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function isForbiddenDirName(name) {
    return FORBIDDEN_DIRS.test(String(name ?? ''));
}

/**
 * Rewrite a relative path with forward slashes.
 * @param {string} relative
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function toPosix(relative) {
    return String(relative ?? '').split(path.sep).join('/');
}

/**
 * Whether the candidate is the root itself or a path under it.
 * @param {string} root
 * @param {string} candidate
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function isInside(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

/**
 * Resolve a path of the model into an absolute path inside the root.
 *
 * The escape is checked twice: once for the written path (`..`), and once for the real
 * path of the deepest existing part, so a symbolic link cannot lead out of the root.
 * @param {string} root the absolute root of the run
 * @param {string} relative the path of the model
 * @param {{ forWrite?: boolean, allowRoot?: boolean }} [options]
 * @returns {Promise<{ abs: string, rel: string }>} the absolute path and the POSIX path
 *   relative to the root
 * @exports
 * @ai.hint io
 */
export async function resolveInside(root, relative, { forWrite = false, allowRoot = true } = {}) {
    if (typeof relative !== 'string') throw new Error('The path must be a string.');
    if (relative.includes('\0')) throw new Error('The path contains a NUL.');
    const base = path.resolve(String(root));
    const cleaned = relative.trim() === '' || relative.trim() === '.' ? '.' : relative.trim();
    const abs = path.resolve(base, cleaned);
    if (!isInside(base, abs)) throw new Error(`The path is outside the working directory: ${relative}`);
    const rel = toPosix(path.relative(base, abs));
    if (rel === '' && !allowRoot) throw new Error('A path to a file is needed, not to the root.');
    const segments = rel ? rel.split('/') : [];
    for (const [index, segment] of segments.entries()) {
        if (FORBIDDEN_DIRS.test(segment)) throw new Error(`The access is denied: ${rel}`);
        if (index === segments.length - 1 && PROTECTED_FILES.test(segment)) throw new Error(`The file with the secret is not accessible: ${rel}`);
        if (forWrite && READ_ONLY_DIRS.test(segment)) throw new Error(`The write into ${segment} is denied: ${rel}`);
    }
    let probe = abs;
    for (;;) {
        const info = await lstat(probe).catch(() => null);
        if (info) {
            const real = await realpath(probe).catch(() => probe);
            const realRoot = await realpath(base).catch(() => base);
            if (!isInside(realRoot, real)) throw new Error(`The path through a symbolic link leaves the working directory: ${rel}`);
            break;
        }
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
    }
    return { abs, rel: rel || '.' };
}

/**
 * The access of one root: the root itself and the resolver of the paths.
 * @param {{ root: string }} options
 * @returns {{ root: string, resolve: (relative: string, options?: object) => Promise<{ abs: string, rel: string }> }}
 * @exports
 * @ai.hint pure
 */
export function createAccess({ root } = {}) {
    const base = path.resolve(String(root ?? process.cwd()));
    return {
        root: base,
        /**
         * @param {string} relative
         * @param {{ forWrite?: boolean, allowRoot?: boolean }} [options]
         * @returns {Promise<{ abs: string, rel: string }>}
         */
        resolve: (relative, options = {}) => resolveInside(base, relative, options),
    };
}
