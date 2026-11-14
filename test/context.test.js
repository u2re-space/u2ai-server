/**
 * @file test/context.test.js
 * @module test/context
 * @purpose The context of a role: the card of the workspace, the parsing of the jsonc,
 *          the entries of the HTML, the mentions of the task, the AGENTS.md of the project,
 *          and the suggestions of the paths and the commands.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  parseJsonc,
  extractHtmlEntries,
  resolveSpecifier,
  mergeTaskDraft,
  formatWorkspace,
  scanWorkspace,
} from '../src/tools/context.js';
import {
  parseMention,
  collectMentions,
  discoverAgents,
  collectRoleContext,
  formatRoleContext,
  AGENT_FILE_NAMES,
} from '../src/agent/context.js';
import { suggestPaths, suggestCommands, suggest } from '../src/tools/suggest.js';
import { TOOL_SPECS, executeTool, toolCategory } from '../src/tools/tools.js';

/**
 * A fresh project for one test.
 * @returns {Promise<string>}
 */
async function tempProject() {
  return mkdtemp(path.join(os.tmpdir(), 'ai-serve-context-'));
}

/**
 * A Node.js project with an entry point.
 * @returns {Promise<string>}
 */
async function nodeProject() {
  const root = await tempProject();
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'demo',
    main: 'src/index.js',
    scripts: { test: 'node --test', build: 'node build.js' },
  }), 'utf8');
  await writeFile(path.join(root, 'src', 'index.js'), "import { a } from './a.js';\nexport const b = a;\n", 'utf8');
  await writeFile(path.join(root, 'src', 'a.js'), 'export const a = 1;\n', 'utf8');
  return root;
}

test('the jsonc parser reads the comments and the trailing commas', () => {
  const out = parseJsonc(`{
    // a comment
    "a": 1, /* another */
    "b": [1, 2,],
  }`);
  assert.deepEqual(out, { a: 1, b: [1, 2] });
});

test('the jsonc parser keeps the comment inside a string', () => {
  const out = parseJsonc('{"url": "https://example.com//path"}');
  assert.equal(out.url, 'https://example.com//path');
});

test('the jsonc parser answers null for a broken text', () => {
  assert.equal(parseJsonc('{ "a": }'), null);
  assert.equal(parseJsonc('42'), null);
  assert.equal(parseJsonc(''), null);
});

test('the html entries name the scripts, the styles and the import map', () => {
  const out = extractHtmlEntries(`<!doctype html>
    <link rel="stylesheet" href="/styles.css">
    <script type="module" src="/app.js"></script>
    <script src="/legacy.js"></script>
    <script type="importmap">{"imports": {"lib": "/lib.js"}}</script>`);
  assert.equal(out.scripts.length, 2);
  assert.deepEqual(out.scripts[0], { src: '/app.js', module: true });
  assert.equal(out.scripts[1].module, false);
  assert.deepEqual(out.styles, ['/styles.css']);
  assert.deepEqual(out.importMap.imports, { lib: '/lib.js' });
});

test('the html entries keep the linked import map', () => {
  const out = extractHtmlEntries('<script type="importmap" src="/map.json"></script>');
  assert.equal(out.importMapSrc, '/map.json');
  assert.equal(out.importMap, null);
});

test('the specifier of a relative path gets the extensions', () => {
  const out = resolveSpecifier('./a', { from: 'src/index.js' });
  assert.ok(out.includes('src/a.js'));
  assert.ok(out.includes('src/a/index.js'));
});

test('the specifier of an alias uses the paths of the config', () => {
  const out = resolveSpecifier('@app/main', { paths: { '@app/*': ['src/*'] }, baseUrl: '.' });
  assert.ok(out.includes('src/main.js'));
});

test('the specifier of an import map uses the map', () => {
  const out = resolveSpecifier('lib', { importMap: { imports: { lib: '/vendor/lib.js' } } });
  assert.ok(out.includes('vendor/lib.js'));
});

test('the specifier of a package leaves the root alone', () => {
  assert.deepEqual(resolveSpecifier('node:fs'), []);
  assert.deepEqual(resolveSpecifier('https://example.com/a.js'), []);
});

test('the draft merges the files of the card and the files of the plan', () => {
  const out = mergeTaskDraft(
    { edit: [{ path: 'b.js', role: 'edit', reason: 'planned' }], read: [], scan: [] },
    [{ path: 'a.js', role: 'read', reason: 'entry' }],
  );
  assert.deepEqual(out.read.map((item) => item.path), ['a.js']);
  assert.deepEqual(out.edit.map((item) => item.path), ['b.js']);
});

test('the draft drops a file of an unknown role', () => {
  const out = mergeTaskDraft({ edit: [{ path: 'a.js', role: 'write' }] }, []);
  assert.deepEqual(out.edit, []);
  assert.deepEqual(out.read, []);
  assert.deepEqual(out.scan, []);
});

test('the card of an empty directory is empty', () => {
  assert.equal(formatWorkspace(null), '');
});

test('the workspace scan answers null when there is nothing to read', async () => {
  const root = await tempProject();
  assert.equal(await scanWorkspace(root), null);
});

test('the workspace scan reads the package and the entry point', async () => {
  const root = await nodeProject();
  const card = await scanWorkspace(root);
  assert.equal(card.kind, 'node');
  assert.equal(card.configFile, null);
  assert.ok(card.files.some((file) => file.path === 'src/index.js'));
});

test('the workspace scan names the file the task mentions', async () => {
  const root = await nodeProject();
  const card = await scanWorkspace(root, { task: 'fix the bug in src/a.js' });
  const found = card.files.find((file) => file.path === 'src/a.js');
  assert.ok(found);
  assert.equal(found.role, 'edit');
});

test('the workspace scan reads the index.html of a frontend', async () => {
  const root = await tempProject();
  await writeFile(path.join(root, 'index.html'), '<script type="module" src="/app.js"></script>', 'utf8');
  await writeFile(path.join(root, 'app.js'), 'export const a = 1;\n', 'utf8');
  const card = await scanWorkspace(root);
  assert.equal(card.kind, 'frontend');
  assert.equal(card.indexHtml.scripts.length, 1);
});

test('the workspace scan notes a broken config', async () => {
  const root = await tempProject();
  await writeFile(path.join(root, 'package.json'), '{ "name": }', 'utf8');
  const card = await scanWorkspace(root);
  assert.ok(card.notes.some((note) => /package\.json/.test(note)));
});

test('the card of the workspace becomes a prompt block', async () => {
  const root = await nodeProject();
  const text = formatWorkspace(await scanWorkspace(root));
  assert.match(text, /Workspace: node/);
  assert.match(text, /Scanner files:/);
});

test('a mention names the file and the lines', () => {
  assert.deepEqual(parseMention('@src/index.js'), { path: 'src/index.js', start: null, end: null });
  assert.deepEqual(parseMention('src/index.js#10-40'), { path: 'src/index.js', start: 10, end: 40 });
  assert.equal(parseMention('@../secret.js'), null);
  assert.equal(parseMention('@/etc/passwd'), null);
  assert.equal(parseMention('@https://example.com/a.js'), null);
});

test('the mentions of a text are collected', () => {
  const out = collectMentions('look at @src/index.js and @src/a.js#1-5');
  assert.deepEqual(out.map((item) => item.path), ['src/index.js', 'src/a.js']);
});

test('the rules of the project are found', async () => {
  const root = await tempProject();
  await writeFile(path.join(root, 'AGENTS.md'), 'Use the tabs.\n', 'utf8');
  const out = await discoverAgents({ cwd: root });
  assert.ok(out.files.some((file) => file.path.endsWith('AGENTS.md')));
  assert.match(out.text, /Use the tabs/);
});

test('the names of the rules files are known', () => {
  assert.deepEqual([...AGENT_FILE_NAMES], ['AGENTS.md', 'agents.md']);
});

test('the context of a role holds the workspace, the rules and the mentions', async () => {
  const root = await nodeProject();
  await writeFile(path.join(root, 'AGENTS.md'), 'Keep it small.\n', 'utf8');
  const out = await collectRoleContext({ root, task: 'read @src/a.js', role: 'coder' });
  assert.equal(out.role, 'coder');
  assert.match(out.text, /Workspace: node/);
  assert.match(out.text, /Keep it small/);
  assert.deepEqual(out.mentions.map((item) => item.path), ['src/a.js']);
  assert.ok(out.files.some((file) => file.path === 'src/a.js'));
});

test('the context of a role ignores a mention of a missing file', async () => {
  const root = await nodeProject();
  const out = await collectRoleContext({ root, task: 'read @src/nope.js' });
  assert.deepEqual(out.mentions, []);
});

test('the context block of an empty context is empty', () => {
  assert.equal(formatRoleContext(null), '');
});

test('the suggestions of the paths carry the prefix', async () => {
  const root = await nodeProject();
  const out = await suggestPaths({ root, prefix: 'a' });
  assert.ok(out.paths.includes('src/a.js'));
});

test('the suggestions of the paths skip the noisy folders', async () => {
  const root = await nodeProject();
  await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'x', 'utf8');
  const out = await suggestPaths({ root, prefix: 'index' });
  assert.ok(!out.paths.some((item) => item.includes('node_modules')));
});

test('the suggestions of the commands know the scripts', async () => {
  const root = await nodeProject();
  const out = await suggestCommands({ root });
  assert.ok(out.commands.includes('npm test'));
  assert.ok(out.commands.includes('npm run build'));
});

test('the suggestions answer the paths and the commands at once', async () => {
  const root = await nodeProject();
  const out = await suggest({ root, prefix: 'src', kind: 'all' });
  assert.ok(out.paths.length > 0);
  assert.ok(out.commands.length > 0);
  const onlyCommands = await suggest({ root, kind: 'command' });
  assert.deepEqual(onlyCommands.paths, []);
});

test('the context tools are in the catalog', () => {
  assert.equal(toolCategory('scan_workspace'), 'read');
  assert.equal(toolCategory('collect_context'), 'read');
  assert.equal(toolCategory('suggest'), 'read');
  assert.equal(TOOL_SPECS.scan_workspace.group, 'workspace');
  assert.equal(TOOL_SPECS.suggest.group, 'suggest');
  assert.deepEqual(TOOL_SPECS.suggest.parameters.required, []);
});

test('executeTool scans the workspace', async () => {
  const root = await nodeProject();
  const out = await executeTool('scan_workspace', { task: '' }, { root });
  assert.match(out.text, /Workspace: node/);
});

test('executeTool collects the context', async () => {
  const root = await nodeProject();
  const out = await executeTool('collect_context', { task: 'read @src/a.js', role: 'coder' }, { root });
  assert.match(out.text, /src\/a\.js/);
});

test('executeTool suggests the paths and the commands', async () => {
  const root = await nodeProject();
  const out = await executeTool('suggest', { prefix: 'a', kind: 'all' }, { root });
  assert.match(out.text, /src\/a\.js/);
  assert.match(out.text, /npm test/);
});
