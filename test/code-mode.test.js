/**
 * @file test/code-mode.test.js
 * @module test/code-mode
 * @purpose Tests of Code Mode in the server: the tool, the sandbox and the approval.
 * @depends node:test, node:assert, tools/tools, agent/code-mode
 * @ai.tags test, code-mode, sandbox
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';

import { executeTool, TOOL_SPECS, TOOL_NAMES, toolAllowed, toolCategory, toolRisk } from '../src/tools/tools.js';
import { runCodeModeWorker } from '../src/shared/house/code-mode.js';

test('the tool of Code Mode is in the catalogue of the server', () => {
    assert.ok(TOOL_SPECS.code_mode, 'the tool of Code Mode is in the catalogue');
    assert.ok(TOOL_NAMES.includes('code_mode'));
    // Code Mode is a write: the program calls the tools of the server, and the server
    // writes the files with its own hands.
    assert.equal(toolCategory('code_mode'), 'write');
    assert.equal(toolRisk('code_mode'), 'medium');
    // The switch of the config decides whether the run may use it.
    assert.equal(toolAllowed('code_mode', { tools: {} }), true);
    assert.equal(toolAllowed('code_mode', { tools: { code_mode: false } }), false);
});

test('a program of the model calls the tools of the server and writes the files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-serve-code-mode-'));
    try {
        await writeFile(path.join(root, 'a.txt'), 'alpha', 'utf8');
        await writeFile(path.join(root, 'b.txt'), 'beta', 'utf8');

        const out = await executeTool('code_mode', {
            code: `
                const a = await tools.read_file({ path: 'a.txt' });
                const b = await tools.read_file({ path: 'b.txt' });
                await tools.write_file({ path: 'merged.txt', content: a + '|' + b });
                return { a, b };
            `,
        }, { root, config: { tools: {} } });

        assert.match(out.text, /The program ran/);
        assert.match(out.text, /read_file/);
        // The file was written by the tools of the server, with its own rights.
        const merged = await readFile(path.join(root, 'merged.txt'), 'utf8');
        assert.match(merged, /alpha/);
        assert.match(merged, /beta/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the access of the run is a facility of the server too', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-serve-access-'));
    try {
        await writeFile(path.join(root, 'a.txt'), 'alpha', 'utf8');
        const out = await executeTool('code_mode', {
            code: `
                const catalog = await library.catalog();
                const read = await library.call('access.readFile', [{ path: 'a.txt' }]);
                await library.call('access.writeFile', [{ path: 'out.txt', content: 'from the program' }]);
                return {
                    hasAccess: catalog.some((entry) => entry.facility && entry.name === 'access.readFile'),
                    content: read.content,
                };
            `,
        }, { root, config: { tools: {} } });
        assert.match(out.text, /The program ran/);
        assert.match(out.text, /"hasAccess": true/);
        assert.match(out.text, /alpha/);
        // The file was written through the gate of the server, with its own backup rules.
        assert.match(await readFile(path.join(root, 'out.txt'), 'utf8'), /from the program/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a program that is not valid says so and writes nothing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-serve-code-mode-'));
    try {
        const out = await executeTool('code_mode', { code: 'const = ;' }, { root, config: { tools: {} } });
        assert.match(out.text, /did not run/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a program of the server may not walk out of the sandbox', async () => {
    const report = await runCodeModeWorker({
        spec: {
            code: `
                const probe = (fn) => {
                    try { return String(fn()); } catch (error) { return 'BLOCKED'; }
                };
                return {
                    viaTool: probe(() => tools.read_file.constructor('return typeof process')()),
                    viaShared: probe(() => shared.view.constructor.constructor('return typeof process')()),
                    viaGlobal: probe(() => globalThis.constructor.constructor('return typeof process')()),
                    hasProcess: typeof process,
                };
            `,
            tools: [{ name: 'read_file' }],
        },
        onCall: async () => 'ok',
    });
    assert.equal(report.ok, true);
    for (const [name, value] of Object.entries(report.value)) {
        if (name === 'hasProcess') {
            assert.equal(value, 'undefined');
            continue;
        }
        assert.ok(value === 'BLOCKED' || value === 'undefined', `the program walked out through ${name}`);
    }
});
