/**
 * @file src/agent/access.js
 * @module agent/access
 * @purpose Keep the paths of the model inside the root of the run and away from the secrets.
 *
 *   The rules themselves live in `access/paths`: they are the rules of the whole access
 *   layer, and the tools of the package borrow them from there. This module stays as the
 *   door the tools already know, so nothing outside changes.
 *
 *   The model names paths; the server touches the disk. Between those two there is this
 *   module: it turns a relative path into an absolute one, refuses the paths that leave
 *   the root (through `..` or through a symbolic link), refuses the secret files and the
 *   secret directories, and refuses the writes into the read-only directories.
 *
 * @depends access/paths
 * @usedBy tools/filesystem, tools/terminal, tools/context, agent/roles
 * @exports NOISY_DIRS, isProtectedFileName, isForbiddenDirName, toPosix, isInside,
 *          resolveInside, createAccess
 * @ai.tags paths, sandbox
 * @ai.hint keep
 */

import {
    resolveInside,
    isInside,
    toPosix,
    isProtectedFileName,
    isForbiddenDirName,
    NOISY_DIRS,
    createPathAccess,
} from '../access/paths.js';

export { resolveInside, isInside, toPosix, isProtectedFileName, isForbiddenDirName, NOISY_DIRS };

/**
 * The access of one root: the root itself and the resolver of the paths.
 * @param {{ root: string }} options
 * @returns {{ root: string, resolve: (relative: string, options?: object) => Promise<{ abs: string, rel: string }> }}
 * @exports
 * @ai.hint pure
 */
export function createAccess({ root } = {}) {
    return createPathAccess({ root });
}
