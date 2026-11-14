/**
 * @file src/cli/compatibility.js
 * @module cli/compatibility
 * @purpose The Node.js version the CLI needs.
 * @exports checkNodeVersion, REQUIRED_NODE
 * @ai.hint keep
 */

/** The major version of Node.js this CLI runs on. */
export const REQUIRED_NODE = 26;

/**
 * Verify that the current Node.js version meets the requirement.
 * @returns {{ ok: boolean, version: string, required: string }}
 * @exports
 * @ai.hint pure
 */
export function checkNodeVersion() {
    const version = process.versions.node;
    const major = Number.parseInt(version, 10);
    return { ok: major >= REQUIRED_NODE, version, required: `>=${REQUIRED_NODE}` };
}
