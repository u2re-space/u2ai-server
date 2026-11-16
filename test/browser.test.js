/**
 * @file test/browser.test.js
 * @module test/browser
 * @purpose The tests of the eye of the service: the engines, the local server and the
 *          screenshot of the page.
 * @depends node:test, node:fs/promises, tools/browser, tools/tools
 * @ai.tags test, browser, screenshot
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';

import {
    chromeArgs,
    chromiumCandidates,
    egoCandidates,
    findChromium,
    findEgo,
    resolveEngine,
    startStaticServer,
} from '../src/tools/browser.js';
import { TOOL_SPECS, toolAllowed, toolCategory } from '../src/tools/tools.js';

/**
 * A fresh directory with one page for one test.
 * @returns {Promise<{ root: string, cleanup: () => Promise<void> }>}
 */
async function project() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-serve-browser-'));
    await writeFile(path.join(root, 'index.html'), '<!doctype html><html><body><h1>Page</h1></body></html>', 'utf8');
    return {
        root,
        cleanup: async () => {
            const { rm } = await import('node:fs/promises');
            await rm(root, { recursive: true, force: true });
        },
    };
}

test('the places of the engines are known', () => {
    // The command of the ego lite is `ego`, not `ego-browser`.
    const ego = egoCandidates(null, { PATH: '/usr/bin' });
    assert.ok(ego.some((item) => path.basename(item) === 'ego'));
    assert.ok(!ego.some((item) => item.includes('ego-browser')));
    assert.ok(chromiumCandidates(null, { ProgramFiles: 'C:/Program Files' }, 'win32').some((item) => item.endsWith('chrome.exe')));
    assert.ok(chromiumCandidates(null, {}, 'darwin').some((item) => item.includes('Google Chrome')));
});

test('the engine is chosen by what is installed', async () => {
    // The `auto` mode takes the headless Chromium: the snapshot of the page is taken headless.
    const auto = await resolveEngine({ browser: {} }, {
        findEgo: async () => 'C:/ego/ego.exe',
        findChromium: async () => 'C:/chrome/chrome.exe',
    });
    assert.equal(auto.engine, 'chrome');

    const chrome = await resolveEngine({ browser: {} }, {
        findEgo: async () => null,
        findChromium: async () => 'C:/chrome/chrome.exe',
    });
    assert.equal(chrome.engine, 'chrome');
    assert.equal(chrome.interactions, false);

    await assert.rejects(
        () => resolveEngine({ browser: {} }, { findEgo: async () => null, findChromium: async () => null }),
        /No browser was found|Chromium/,
    );
});

test('the arguments of the headless Chromium are the ones of a screenshot', () => {
    const args = chromeArgs({
        mode: 'screenshot',
        url: 'http://127.0.0.1:8080/index.html',
        output: 'C:/shot.png',
        width: 1440,
        height: 900,
        budgetMs: 5000,
        userDataDir: 'C:/profile',
    });
    assert.ok(args.includes('--headless=new'));
    assert.ok(args.includes('--window-size=1440,900'));
    assert.ok(args.includes('--screenshot=C:/shot.png'));
    assert.equal(args.at(-1), 'http://127.0.0.1:8080/index.html');
});

test('the local server serves the project and keeps the escape out', async () => {
    const { root, cleanup } = await project();
    const server = await startStaticServer(root);
    try {
        const page = await fetch(`${server.url}/index.html`);
        assert.equal(page.status, 200);
        assert.match(await page.text(), /Page/);
        assert.equal((await fetch(`${server.url}/nothing.html`)).status, 404);
        const escape = await fetch(`${server.url}/../../etc/passwd`);
        assert.ok([403, 404].includes(escape.status));
    } finally {
        await server.close();
        await cleanup();
    }
});

test('the eye of the service is a tool of the catalog and it may be switched off', () => {
    assert.ok(TOOL_SPECS.screenshot);
    assert.equal(toolCategory('screenshot'), 'read');
    assert.equal(toolAllowed('screenshot', { tools: { browser: true } }), true);
    assert.equal(toolAllowed('screenshot', { tools: { browser: false } }), false);
});

test('the browser is looked up on the disk of the machine', async () => {
    // The lookup does not need a browser: it says that there is none when there is none.
    const found = await findChromium({ exists: async () => false });
    assert.equal(found, null);
    const ego = await findEgo({ exists: async () => false });
    assert.equal(ego, null);
});
