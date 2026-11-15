/**
 * @file src/server/publish.js
 * @module server/publish
 * @purpose Sign the contract of the project for the work of the server.
 *
 *   The contract of the project is `.ai/manifest.json`: one file that says what every system
 *   of the house made and where it lies. The server signs its own part of it — the files
 *   its run wrote — and never touches the part of another system.
 *
 *   The state of the run lives next to it, in `.ai/tmp/<run-id>/`: what the run was, when it
 *   started, what it changed. The state dies with the run; the contract stays.
 *
 *   The paths in the contract are relative to the project and with forward slashes: the
 *   systems of the house read the contract on another machine and another system, and the
 *   path has to mean the same thing there.
 *
 *   The contract is a hint, not a reason to fail: a run that cannot write it warns and goes
 *   on.
 *
 * @depends node:path, node:fs/promises, shared/house
 * @usedBy server/agent, cli
 * @exports RUN_STATE_FILE, changesRel, publishServer, writeRunState, signRun
 * @ai.tags house, manifest, server
 * @ai.hint io
 */

import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { HOUSE_SYSTEMS, publish, runStateDir, toProjectPath, writeFileAtomic } from '../shared/house.js';

/** The name of the file with the state of a run, inside the directory of the run. */
export const RUN_STATE_FILE = 'run.json';

/** The delivery of the server: the project itself — the files it wrote stay where they are. */
const DELIVERY = '.';

/**
 * The changes of a run as the contract wants them.
 *
 * A path becomes relative to the root of the project and with forward slashes, the
 * duplicates go away, and the order of the run stays.
 * @param {string} root the project directory
 * @param {Array<{ op?: string, path?: string }|string>} changes the changes of the run
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function changesRel(root, changes = []) {
    const base = path.resolve(String(root ?? process.cwd()));
    const list = Array.isArray(changes) ? changes : [];
    const seen = new Set();
    const out = [];
    for (const change of list) {
        const raw = typeof change === 'string' ? change : change?.path;
        const text = String(raw ?? '').trim();
        if (!text) continue;
        const rel = path.isAbsolute(text) ? toProjectPath(base, text) : text.split(path.sep).join('/');
        if (!rel || seen.has(rel)) continue;
        seen.add(rel);
        out.push(rel);
    }
    return out;
}

/**
 * Sign the contract of the project for the server.
 *
 * The section of the server is its own: the other systems keep theirs.
 * @param {string} [root] the project directory
 * @param {{ changes?: Array<object|string>, delivery?: string }} [payload]
 * @returns {Promise<object>} the contract after the change
 * @exports
 * @ai.hint io
 */
export async function publishServer(root = process.cwd(), { changes = [], delivery = DELIVERY } = {}) {
    const files = changesRel(root, changes);
    return await publish(root, HOUSE_SYSTEMS.server, {
        delivery,
        artifacts: { changes: files },
    });
}

/**
 * Write the state of a run into the house of the project.
 *
 * The state is written whole: a run that dies in the middle leaves the old state and not
 * half of a new one.
 * @param {string} [root] the project directory
 * @param {string} runId the id of the run
 * @param {object} [state] the state of the run
 * @returns {Promise<string>} the path of the file with the state
 * @exports
 * @ai.hint io
 */
export async function writeRunState(root = process.cwd(), runId = '', state = {}) {
    const id = String(runId ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(0, 64);
    const dir = runStateDir(root, id);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, RUN_STATE_FILE);
    await writeFileAtomic(file, `${JSON.stringify({ runId: id, ...state }, null, 2)}\n`);
    return file;
}

/**
 * Sign a run: the state of the run and the contract of the project.
 *
 * A failure is a warning, not a crash: the work of the run is already done, and the
 * contract is only a hint for the other systems of the house.
 * @param {string} [root] the project directory
 * @param {string} runId the id of the run
 * @param {{ changes?: Array<object|string>, state?: object, delivery?: string }} [payload]
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 * @exports
 * @ai.hint io
 */
export async function signRun(root = process.cwd(), runId = '', { changes = [], state = {}, delivery = DELIVERY } = {}) {
    try {
        const files = changesRel(root, changes);
        await writeRunState(root, runId, { ...state, changes: files });
        await publishServer(root, { changes: files, delivery });
        return { ok: true, error: null };
    } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
    }
}
