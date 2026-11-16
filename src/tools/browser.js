/**
 * @file src/tools/browser.js
 * @module tools/browser
 * @purpose The eye of the server: a screenshot of the page the editor works on.
 *
 *   The editor sees the code; the page is another thing. A tool that opens the page of the
 *   working directory in a real browser and takes a picture of it lets the agent look at what
 *   it has written — the layout, the proportions, the type — instead of guessing from the CSS.
 *
 *   Two engines are supported:
 *
 *   - Ego Lite (`ego`), when it is installed: the browser of the house.
 *   - headless Chromium (Chrome or Edge): a read-only engine that opens a page and takes a
 *     picture of it. It is on every desktop.
 *
 *   The project is served by a local server of the package: a `file://` URL breaks the modules
 *   and the fetch of a modern project, so the server answers over HTTP on the loopback.
 *
 * @depends node:path, node:fs/promises, node:os, node:http, tools/terminal, agent/access
 * @usedBy tools/tools
 * @exports chromiumCandidates, egoCandidates, findEgo, findChromium, resolveEngine,
 *          chromeArgs, startStaticServer, screenshotPage
 * @ai.tags browser, screenshot, vision
 * @ai.hint io
 * @changed 2026-11-16 Зрение MCP-сервера: снимок страницы рабочего каталога.
 */

import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';

import { runProgram } from './terminal.js';
import { resolveInside } from '../agent/access.js';
import { collectPageDiagnostics, diagnosticsText } from './cdp.js';

/** The Chromium builds of the desktop: Chrome and Edge, in the usual places. */
const CHROME_WIN = [
    'Google/Chrome/Application/chrome.exe',
    'Microsoft/Edge/Application/msedge.exe',
];
const CHROME_MAC = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];
const CHROME_LINUX = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']
    .map((name) => `/usr/bin/${name}`);

const EGO_NOT_FOUND = 'ego is not in the PATH. Install Ego Lite (https://lite.ego.app/) or set browser.executable.';

/**
 * Whether stat reports an existing file. A missing path returns false.
 * @param {string} filePath
 * @returns {Promise<boolean>}
 * @ai.hint io
 */
async function isFile(filePath) {
    try {
        return (await stat(filePath)).isFile();
    } catch {
        return false;
    }
}

/**
 * The places the `ego` command may live: the PATH, then the folders of the install.
 *
 * The command of the ego lite is `ego` — the application of Citro Labs, not `ego-browser`.
 * @param {string|null} configured
 * @param {object} env
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function egoCandidates(configured = null, env = process.env) {
    const names = configured
        ? [path.basename(configured)]
        : ['ego', 'ego.exe', 'ego.cmd', 'ego.bat'];
    const result = configured ? [configured] : [];
    const push = (dir) => {
        for (const name of names) {
            const candidate = path.join(dir, name);
            if (!result.includes(candidate)) result.push(candidate);
        }
    };
    for (const dir of String(env.PATH || env.Path || '').split(path.delimiter)) {
        if (dir.trim()) push(dir.trim());
    }
    const home = env.HOME || env.USERPROFILE || os.homedir();
    if (home) {
        push(path.join(home, '.local', 'bin'));
        push(path.join(home, '.local', 'share', 'ego'));
        push(path.join(home, 'Applications', 'ego lite.app', 'Contents', 'MacOS'));
    }
    // The install of the ego lite on Windows: «Citro Labs\ego lite\Application\ego.exe».
    if (process.platform === 'win32') {
        const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean);
        for (const root of roots) push(path.join(root, 'Citro Labs', 'ego lite', 'Application'));
    }
    return result;
}

/**
 * The places a Chromium browser may live: the configured one first, then the usual installs.
 * @param {string|null} configured
 * @param {object} env
 * @param {string} platform
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function chromiumCandidates(configured = null, env = process.env, platform = process.platform) {
    const candidates = configured ? [configured] : [];
    if (platform === 'win32') {
        const roots = [env?.ProgramFiles, env?.['ProgramFiles(x86)'], env?.LOCALAPPDATA].filter(Boolean);
        for (const suffix of CHROME_WIN) {
            for (const root of roots) candidates.push(path.join(root, suffix));
        }
    } else if (platform === 'darwin') {
        candidates.push(...CHROME_MAC);
    } else {
        candidates.push(...CHROME_LINUX);
    }
    return [...new Set(candidates)];
}

/**
 * Find the `ego` command of the house.
 * @param {{ executable?: string|null, env?: object, exists?: Function }} [options]
 * @returns {Promise<string|null>}
 * @exports
 * @ai.hint io
 */
export async function findEgo({ executable = null, env = process.env, exists = isFile } = {}) {
    for (const candidate of egoCandidates(executable, env)) {
        if (await exists(candidate)) return candidate;
    }
    return null;
}

/**
 * Find a Chromium browser of the desktop.
 * @param {{ executable?: string|null, env?: object, exists?: Function, platform?: string }} [options]
 * @returns {Promise<string|null>}
 * @exports
 * @ai.hint io
 */
export async function findChromium({ executable = null, env = process.env, exists = isFile, platform = process.platform } = {}) {
    for (const candidate of chromiumCandidates(executable, env, platform)) {
        if (await exists(candidate)) return candidate;
    }
    return null;
}

/**
 * The engine of the run: headless Chromium, or Ego Lite when the user asks for it.
 *
 * The `auto` mode takes the Chromium: the snapshot of the page is taken headless, and the ego
 * lite is a windowed application — it hands the page to the session that is already open and
 * gives nothing back to the caller. The ego lite is named `ego` (`ego nodejs -e …`), not
 * `ego-browser`.
 * @param {object} config
 * @param {{ findEgo?: Function, findChromium?: Function }} [options]
 * @returns {Promise<{ engine: 'ego'|'chrome', executable: string, interactions: boolean, ego: string|null, chrome: string|null }|null>}
 * @exports
 * @ai.hint io
 */
export async function resolveEngine(config = {}, { findEgo: findEgoFn = findEgo, findChromium: findChromiumFn = findChromium } = {}) {
    const browser = config?.browser ?? {};
    const preference = browser.engine ?? 'auto';
    const executable = typeof browser.executable === 'string' && browser.executable.trim() ? browser.executable.trim() : null;
    const selected = preference === 'auto' && executable
        ? (/^ego(?:\.exe|\.cmd|\.bat)?$/i.test(path.basename(executable)) ? 'ego' : 'chrome')
        : preference;
    const ego = selected === 'chrome' ? null : await findEgoFn({ executable: selected === 'ego' ? executable : null, env: process.env });
    const chrome = selected === 'ego' ? null : await findChromiumFn({ executable: selected === 'chrome' ? executable : null, env: process.env });
    if (selected === 'auto') {
        if (chrome) return { engine: 'chrome', executable: chrome, interactions: false, ego, chrome };
        if (ego) return { engine: 'ego', executable: ego, interactions: true, ego, chrome };
        throw new Error(`No browser was found. Install Chrome/Edge or set browser.executable (${CHROME_WIN.join(' | ')}).`);
    }
    if (ego) return { engine: 'ego', executable: ego, interactions: true, ego, chrome };
    if (chrome) return { engine: 'chrome', executable: chrome, interactions: false, ego, chrome };
    if (selected === 'chrome') throw new Error(`No Chromium browser was found. Set browser.executable (${CHROME_WIN.join(' | ')}).`);
    throw new Error(EGO_NOT_FOUND);
}

/**
 * The arguments of one headless Chromium call.
 * @param {{ mode: 'screenshot'|'dump-dom', url: string, output?: string|null, width?: number, height?: number, budgetMs?: number, userDataDir: string }} options
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function chromeArgs({ mode, url, output = null, width = 1440, height = 900, budgetMs = 8000, userDataDir }) {
    const args = [
        '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
        '--disable-background-networking', '--disable-extensions', '--disable-sync', '--disable-component-update',
        '--hide-scrollbars', `--user-data-dir=${userDataDir}`,
        `--virtual-time-budget=${Math.max(100, Math.min(60000, Math.round(budgetMs)))}`,
    ];
    if (mode === 'screenshot') {
        args.push(`--window-size=${Math.round(width)},${Math.round(height)}`);
        args.push(`--screenshot=${output}`);
    } else {
        args.push('--dump-dom');
    }
    args.push(url);
    return args;
}

/**
 * The MIME types of the files the local server serves.
 * @type {Readonly<Record<string, string>>}
 */
const MIME = Object.freeze({
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.webmanifest': 'application/manifest+json',
});

/**
 * Serve a directory over HTTP on a free port of the loopback.
 *
 * The server answers only what is inside the directory: a path that climbs out of it gets
 * nothing.
 * @param {string} root
 * @param {{ port?: number, host?: string }} [options]
 * @returns {Promise<{ url: string, port: number, close: Function }>}
 * @exports
 * @ai.hint io
 */
export async function startStaticServer(root, { port = 0, host = '127.0.0.1' } = {}) {
    const base = path.resolve(String(root ?? process.cwd()));
    const server = createServer(async (req, res) => {
        try {
            const request = new URL(req.url || '/', `http://${host}`);
            let rel = decodeURIComponent(request.pathname);
            if (rel.endsWith('/')) rel += 'index.html';
            const target = path.resolve(base, `.${rel}`);
            const inside = target === base || target.startsWith(base + path.sep);
            if (!inside) {
                res.writeHead(403).end('Forbidden');
                return;
            }
            const info = await stat(target).catch(() => null);
            if (!info?.isFile()) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
                return;
            }
            const body = await readFile(target);
            const type = MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length }).end(body);
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
                .end(String(error?.message ?? error));
        }
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
    });
    const address = server.address();
    const actual = typeof address === 'object' && address ? address.port : port;
    return {
        url: `http://${host}:${actual}`,
        port: actual,
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}

/**
 * The entry point of the project: the page the browser opens.
 * @param {string} root
 * @returns {Promise<string|null>}
 * @exports
 * @ai.hint io
 */
export async function entryPage(root) {
    for (const name of ['index.html', 'src/index.html', 'public/index.html', 'dist/index.html']) {
        const found = await stat(path.join(root, name)).then((info) => info.isFile()).catch(() => false);
        if (found) return name;
    }
    return null;
}

/**
 * The screenshot of a page of the project, with what the page says about itself.
 *
 * The picture is written inside the working directory, so the agent may read it back and the
 * user may open it. The console, the exceptions and the failed requests come along: they name
 * the cause of what the picture shows.
 * @param {{ root: string, config?: object, env?: object, page?: string|null, output?: string,
 *   width?: number, height?: number, timeoutMs?: number, engine?: object|null, url?: string|null }} options
 * @returns {Promise<{ path: string, rel: string, bytes: number, engine: string, url: string,
 *   console: object[], errors: object[], failed: object[], log: string }>}
 * @exports
 * @ai.hint io
 */
export async function screenshotPage({
    root,
    config = {},
    env = process.env,
    page = null,
    output = '',
    width = 1440,
    height = 900,
    timeoutMs = 45_000,
    engine = null,
    url = null,
} = {}) {
    const target = output
        ? (await resolveInside(root, output, { forWrite: true, allowRoot: false })).abs
        : path.join(root, '.ai', 'shots', `page-${Date.now().toString(36)}.png`);
    await import('node:fs/promises').then((fs) => fs.mkdir(path.dirname(target), { recursive: true }));
    const chosen = engine ?? await resolveEngine(config, {
        findEgo: async () => await findEgo({ env }),
        findChromium: async () => await findChromium({ env }),
    });
    if (!chosen?.chrome) {
        throw new Error(`The engine ${chosen?.engine ?? 'none'} cannot shoot a page without Chromium. Install Chrome/Edge.`);
    }
    // A live address wins: the dev server of the project shows the styles as they are now.
    const server = url ? null : await startStaticServer(root);
    try {
        const entry = url ? '' : (page ?? await entryPage(root));
        if (!url && !entry) throw new Error('No page was found: the project has no index.html.');
        const address = url || `${server.url}/${entry.split('/').map(encodeURIComponent).join('/')}`;
        // The protocol gives the picture and the words of the page in one pass.
        try {
            const collected = await collectPageDiagnostics({
                executable: chosen.chrome,
                url: address,
                width,
                height,
                timeoutMs,
                cwd: root,
                env,
            });
            if (collected.screenshot) {
                const bytes = Buffer.from(collected.screenshot, 'base64');
                await writeFile(target, bytes);
                const { rel } = await resolveInside(root, path.relative(root, target), { allowRoot: false });
                return {
                    path: target,
                    rel,
                    bytes: bytes.length,
                    engine: chosen.engine,
                    url: address,
                    console: collected.console,
                    errors: collected.errors,
                    failed: collected.failed,
                    log: diagnosticsText(collected),
                };
            }
        } catch {
            // The protocol is not always there: the run falls back to the plain screenshot.
        }
        const profile = await mkdtemp(path.join(os.tmpdir(), 'ai-serve-chrome-'));
        try {
            const budget = Math.max(1000, Math.min(timeoutMs - 3000, 20_000));
            const args = chromeArgs({ mode: 'screenshot', url: address, output: target, width, height, budgetMs: budget, userDataDir: profile });
            const result = await runProgram({
                file: chosen.chrome,
                args,
                cwd: root,
                root,
                timeoutMs,
                maxOutputBytes: 256 * 1024,
            });
            if (result?.timedOut) throw new Error(`Chromium did not finish in ${Math.round(timeoutMs / 1000)} s.`);
            const bytes = (await stat(target).catch(() => null))?.size ?? 0;
            if (!bytes) {
                const detail = [result?.stdout, result?.stderr].filter(Boolean).join(' ').trim().slice(0, 400);
                throw new Error(`Chromium did not save the screenshot${detail ? `: ${detail}` : '.'}`);
            }
            const { rel } = await resolveInside(root, path.relative(root, target), { allowRoot: false });
            return {
                path: target,
                rel,
                bytes,
                engine: chosen.engine,
                url: address,
                console: [],
                errors: [],
                failed: [],
                log: '',
            };
        } finally {
            await rm(profile, { recursive: true, force: true }).catch(() => {});
        }
    } finally {
        await server?.close();
    }
}
