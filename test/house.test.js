/**
 * @file test/house.test.js
 * @purpose Tests of the law of the house: where the state of a run lives, how the server
 *          signs the contract of the project and how the home of the service is laid out.
 *
 * The house of a project is `.ai/`: the state of a run in `.ai/tmp/<run-id>/`, the contract
 * in `.ai/manifest.json`. The home of the service is `~/.ai-serve`: the configuration, the
 * MCP servers, the skills, the logs, the address of the server and the state of the runs.
 *
 * @depends node:test, node:fs/promises, node:os, node:path, shared/house, server/publish,
 *          config/paths, access/index, tools/filesystem
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';

import {
    HOUSE_DIR,
    HOUSE_LOGS,
    HOUSE_SYSTEMS,
    HOUSE_TMP,
    HOUSE_WORK,
    MANIFEST_FILE,
    findGenerated,
    houseDir,
    logsDir,
    manifestPath,
    publish,
    readManifest,
    runStateDir,
    toProjectPath,
    writeFileAtomic,
    writeManifest,
} from '../src/shared/house.js';
import { RUN_STATE_FILE, changesRel, publishServer, signRun, writeRunState } from '../src/server/publish.js';
import { homeLayout, homeRunDir, homeTmpDir } from '../src/config/paths.js';
import { createAccess } from '../src/access/index.js';
import { writeTextFile } from '../src/tools/filesystem.js';

/**
 * An empty project in a temporary directory.
 * @returns {Promise<{ root: string, cleanup: () => Promise<void> }>}
 */
async function project() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-serve-house-'));
    return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

// --- the law of the house ----------------------------------------------------

test('the house of a project is one directory', async () => {
    const { root, cleanup } = await project();
    try {
        assert.equal(HOUSE_DIR, '.ai');
        assert.equal(HOUSE_TMP, 'tmp');
        assert.equal(HOUSE_LOGS, 'logs');
        assert.equal(HOUSE_WORK, '.ai/tmp');
        assert.equal(houseDir(root), path.join(root, '.ai'));
        assert.equal(logsDir(root), path.join(root, '.ai', 'logs'));
        assert.equal(manifestPath(root), path.join(root, '.ai', MANIFEST_FILE));
        assert.equal(runStateDir(root, 'run-1'), path.join(root, '.ai', 'tmp', 'run-1'));
    } finally {
        await cleanup();
    }
});

test('the state of a run lives in the temporary directory of the house', async () => {
    const { root, cleanup } = await project();
    try {
        const file = await writeRunState(root, 'run-1', { command: 'run', status: 'completed' });
        assert.equal(file, path.join(root, '.ai', 'tmp', 'run-1', RUN_STATE_FILE));
        const state = JSON.parse(await readFile(file, 'utf8'));
        assert.equal(state.runId, 'run-1');
        assert.equal(state.command, 'run');
        assert.equal(state.status, 'completed');
    } finally {
        await cleanup();
    }
});

test('the id of a run never becomes a strange name of a directory', async () => {
    const { root, cleanup } = await project();
    try {
        const file = await writeRunState(root, '../escape/..', { status: 'completed' });
        assert.equal(path.dirname(path.dirname(file)), path.join(root, '.ai', 'tmp'));
        assert.ok(path.dirname(file).startsWith(path.join(root, '.ai', 'tmp')), file);
    } finally {
        await cleanup();
    }
});

test('the path of a file of the project is relative, a foreign one is absolute', async () => {
    const { root, cleanup } = await project();
    try {
        assert.equal(toProjectPath(root, path.join(root, 'src', 'a.js')), 'src/a.js');
        assert.equal(toProjectPath(root, path.resolve(root, '..', 'outside.js')), path.resolve(root, '..', 'outside.js'));
    } finally {
        await cleanup();
    }
});

// --- the home of the service -------------------------------------------------

test('the home of the service is one layout', async () => {
    const home = path.join(os.tmpdir(), 'ai-serve-home-test');
    const layout = homeLayout(home);
    assert.equal(layout.root, path.resolve(home));
    assert.equal(layout.config, path.join(home, 'config.json'));
    assert.equal(layout.mcp, path.join(home, 'mcp.json'));
    assert.equal(layout.serve, path.join(home, 'serve.json'));
    assert.equal(layout.skills, path.join(home, 'skills'));
    assert.equal(layout.logs, path.join(home, 'logs'));
    assert.equal(layout.tmp, homeTmpDir(home));
    assert.equal(homeRunDir(home, 'run-1'), path.join(home, 'tmp', 'run-1'));
});

// --- the contract of the project ---------------------------------------------

test('a broken contract is read as an empty one, not as an error', async () => {
    const { root, cleanup } = await project();
    try {
        await mkdir(path.join(root, '.ai'), { recursive: true });
        await writeFile(manifestPath(root), '{ this is not json', 'utf8');
        const manifest = await readManifest(root);
        assert.deepEqual(manifest.systems, {});
        assert.equal(manifest.manifestVersion, 1);
    } finally {
        await cleanup();
    }
});

test('the server signs only its own part of the contract', async () => {
    const { root, cleanup } = await project();
    try {
        await publish(root, HOUSE_SYSTEMS.webdev, { delivery: '.', artifacts: { site: '.' } });
        await publishServer(root, { changes: [{ op: 'overwrite', path: 'src/a.js' }] });
        const manifest = await readManifest(root);
        assert.equal(manifest.systems.webdev.delivery, '.');
        assert.equal(manifest.systems.webdev.artifacts.site, '.');
        assert.deepEqual(manifest.systems.server.artifacts.changes, ['src/a.js']);
    } finally {
        await cleanup();
    }
});

test('the changes of a run become the paths of the project', async () => {
    const { root, cleanup } = await project();
    try {
        const changes = changesRel(root, [
            { op: 'overwrite', path: 'src/a.js' },
            { op: 'edit', path: 'src/a.js' },
            { op: 'create', path: path.join(root, 'src', 'b.js') },
            'src/c.js',
            { op: 'delete', path: '  ' },
        ]);
        assert.deepEqual(changes, ['src/a.js', 'src/b.js', 'src/c.js']);
    } finally {
        await cleanup();
    }
});

test('the files of the run are found through the contract', async () => {
    const { root, cleanup } = await project();
    try {
        await mkdir(path.join(root, 'src'), { recursive: true });
        await writeFile(path.join(root, 'src', 'a.js'), 'x', 'utf8');
        await publishServer(root, { changes: [{ op: 'overwrite', path: 'src/a.js' }] });
        const found = await findGenerated(root, 'changes', ['nowhere/a.js']);
        assert.equal(found, 'src/a.js');
    } finally {
        await cleanup();
    }
});

test('the run signs the state and the contract at once', async () => {
    const { root, cleanup } = await project();
    try {
        const answer = await signRun(root, 'run-7', {
            changes: [{ op: 'create', path: 'notes.md' }],
            state: { command: 'run', status: 'completed' },
        });
        assert.equal(answer.ok, true);
        const state = JSON.parse(await readFile(path.join(root, '.ai', 'tmp', 'run-7', RUN_STATE_FILE), 'utf8'));
        assert.deepEqual(state.changes, ['notes.md']);
        const manifest = await readManifest(root);
        assert.deepEqual(manifest.systems.server.artifacts.changes, ['notes.md']);
    } finally {
        await cleanup();
    }
});

test('a run that cannot sign the contract warns and goes on', async () => {
    const { root, cleanup } = await project();
    try {
        // The contract of the project is a directory: the write of it cannot succeed.
        await mkdir(manifestPath(root), { recursive: true });
        const answer = await signRun(root, 'run-8', { changes: [{ op: 'create', path: 'a.js' }] });
        assert.equal(answer.ok, false);
        assert.ok(answer.error, 'the failure has no reason');
    } finally {
        await cleanup();
    }
});

// --- the atomic write --------------------------------------------------------

test('a file appears whole: no temporary file is left', async () => {
    const { root, cleanup } = await project();
    try {
        const file = path.join(root, '.ai', 'manifest.json');
        await writeFileAtomic(file, '{"a":1}');
        assert.equal(await readFile(file, 'utf8'), '{"a":1}');
        assert.deepEqual(await readdir(path.dirname(file)), ['manifest.json']);
    } finally {
        await cleanup();
    }
});

test('the access layer writes a file whole', async () => {
    const { root, cleanup } = await project();
    try {
        const access = createAccess({ root });
        await access.fs.writeText('notes.md', 'the text', { createParents: true });
        assert.equal(await readFile(path.join(root, 'notes.md'), 'utf8'), 'the text');
        assert.deepEqual(await readdir(root), ['notes.md']);
    } finally {
        await cleanup();
    }
});

test('the tool of the write leaves no temporary file', async () => {
    const { root, cleanup } = await project();
    try {
        await writeTextFile({ root, file: 'src/a.js', content: 'the code' });
        assert.equal(await readFile(path.join(root, 'src', 'a.js'), 'utf8'), 'the code');
        assert.deepEqual(await readdir(path.join(root, 'src')), ['a.js']);
    } finally {
        await cleanup();
    }
});
