/**
 * @file test/filesystem.test.js
 * @module test/filesystem
 * @purpose The tools of the file system: the root of the access, the secrets, the list,
 *          the read, the search, the write, the replace, the delete, the copy, and the
 *          schema of the catalog.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveInside, isInside, isProtectedFileName, isForbiddenDirName, toPosix } from '../src/agent/access.js';
import {
  listFiles,
  readTextFile,
  searchFiles,
  writeTextFile,
  replaceInFile,
  deleteFile,
  makeDirectory,
  copyPath,
} from '../src/tools/filesystem.js';
import {
  TOOL_SPECS,
  TOOL_NAMES,
  toolDefinitions,
  describeTool,
  toolCategory,
  toolRisk,
  toolsByCategory,
  executeTool,
} from '../src/tools/tools.js';
import { formatBytes, formatDuration, truncateText } from '../src/shared/format.js';

/**
 * A fresh project for one test.
 * @returns {Promise<string>}
 */
async function tempProject() {
  return mkdtemp(path.join(os.tmpdir(), 'ai-serve-fs-'));
}

/**
 * A project with a few files.
 * @returns {Promise<string>}
 */
async function sampleProject() {
  const root = await tempProject();
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'README.md'), '# Project\n\nHello.\n', 'utf8');
  await writeFile(path.join(root, 'src', 'index.js'), 'export const answer = 42;\n', 'utf8');
  await writeFile(path.join(root, '.env'), 'SECRET=1\n', 'utf8');
  return root;
}

test('a path inside the root is resolved to an absolute path', async () => {
  const root = await tempProject();
  const out = await resolveInside(root, 'src/index.js');
  assert.equal(out.abs, path.join(root, 'src', 'index.js'));
  assert.equal(out.rel, 'src/index.js');
});

test('a path outside the root is refused', async () => {
  const root = await tempProject();
  await assert.rejects(() => resolveInside(root, '../outside.txt'), /outside/);
  await assert.rejects(() => resolveInside(root, 'a/../../outside.txt'), /outside/);
});

test('an absolute path outside the root is refused', async () => {
  const root = await tempProject();
  await assert.rejects(() => resolveInside(root, path.join(os.tmpdir(), 'other.txt')), /outside/);
});

test('a symbolic link that leaves the root is refused', async () => {
  const root = await tempProject();
  const outside = await tempProject();
  await writeFile(path.join(outside, 'outside.txt'), 'x', 'utf8');
  await symlink(outside, path.join(root, 'link'), 'dir');
  await assert.rejects(() => resolveInside(root, 'link/outside.txt'), /symbolic link/);
});

test('the secret files are refused', async () => {
  const root = await sampleProject();
  await assert.rejects(() => resolveInside(root, '.env'), /secret/);
  assert.equal(isProtectedFileName('.env.local'), true);
  assert.equal(isProtectedFileName('server.pem'), true);
  assert.equal(isProtectedFileName('README.md'), false);
});

test('the secret directories are refused', async () => {
  const root = await sampleProject();
  await mkdir(path.join(root, '.ssh'), { recursive: true });
  await assert.rejects(() => resolveInside(root, '.ssh/id_rsa'), /denied/);
  assert.equal(isForbiddenDirName('.gnupg'), true);
});

test('isInside knows the root from the outside', () => {
  assert.equal(isInside('/a/b', '/a/b'), true);
  assert.equal(isInside('/a/b', '/a/b/c'), true);
  assert.equal(isInside('/a/b', '/a/bc'), false);
  assert.equal(isInside('/a/b', '/a'), false);
});

test('toPosix writes the path with slashes', () => {
  assert.equal(toPosix(path.join('a', 'b', 'c')), 'a/b/c');
});

test('the list shows the files of the root', async () => {
  const root = await sampleProject();
  const out = await listFiles({ root });
  assert.match(out.text, /README\.md/);
  assert.match(out.text, /src\//);
  assert.ok(out.count > 0);
});

test('the list skips the noisy folders', async () => {
  const root = await sampleProject();
  await mkdir(path.join(root, 'node_modules'), { recursive: true });
  const out = await listFiles({ root });
  assert.match(out.text, /node_modules/);
  assert.doesNotMatch(out.text, /node_modules\/.*\./);
});

test('the list of a missing path shows the nearest parent', async () => {
  const root = await sampleProject();
  const out = await listFiles({ root, dir: 'src/does/not/exist' });
  assert.equal(out.missing, 'src/does/not/exist');
  assert.match(out.text, /index\.js/);
});

test('the read returns the numbered lines', async () => {
  const root = await sampleProject();
  const out = await readTextFile({ root, file: 'src/index.js' });
  assert.match(out.text, /1\| export const answer = 42;/);
  assert.equal(out.totalLines, 2);
});

test('the read takes a range of the lines', async () => {
  const root = await sampleProject();
  await writeFile(path.join(root, 'long.txt'), Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n'), 'utf8');
  const out = await readTextFile({ root, file: 'long.txt', startLine: 5, endLine: 7 });
  assert.match(out.text, /5\| line 5/);
  assert.doesNotMatch(out.text, /line 8/);
  assert.equal(out.from, 5);
  assert.equal(out.to, 7);
});

test('the read of a secret is refused', async () => {
  const root = await sampleProject();
  await assert.rejects(() => readTextFile({ root, file: '.env' }), /secret/);
});

test('the read of a missing file fails', async () => {
  const root = await sampleProject();
  await assert.rejects(() => readTextFile({ root, file: 'nope.txt' }), /not found/);
});

test('the search finds the text in the files', async () => {
  const root = await sampleProject();
  const out = await searchFiles({ root, query: 'answer' });
  assert.equal(out.count, 1);
  assert.match(out.text, /src\/index\.js:1/);
});

test('the search works with a regular expression', async () => {
  const root = await sampleProject();
  const out = await searchFiles({ root, query: 'answ\\w+ = \\d+', regex: true });
  assert.equal(out.count, 1);
});

test('the search skips the secret files', async () => {
  const root = await sampleProject();
  const out = await searchFiles({ root, query: 'SECRET' });
  assert.equal(out.count, 0);
});

test('the search of a wrong regular expression fails', async () => {
  const root = await sampleProject();
  await assert.rejects(() => searchFiles({ root, query: '[', regex: true }), /regular expression/);
});

test('the search finds the files by their names', async () => {
  const root = await sampleProject();
  const out = await searchFiles({ root, query: 'index', inContent: false });
  assert.equal(out.count, 1);
  assert.match(out.text, /src\/index\.js/);
});

test('the search of the names takes a glob', async () => {
  const root = await sampleProject();
  const out = await searchFiles({ root, query: 'answer', glob: '*.md' });
  assert.equal(out.count, 0);
  const js = await searchFiles({ root, query: 'answer', glob: '*.js' });
  assert.equal(js.count, 1);
  assert.match(js.text, /src\/index\.js:1/);
});

test('the write creates the file and the parents', async () => {
  const root = await tempProject();
  const out = await writeTextFile({ root, file: 'docs/readme.md', content: '# Hi\n' });
  assert.equal(out.created, true);
  assert.equal(out.rel, 'docs/readme.md');
  assert.equal(await readFile(path.join(root, 'docs', 'readme.md'), 'utf8'), '# Hi\n');
});

test('the write refuses to overwrite when overwrite is false', async () => {
  const root = await sampleProject();
  await assert.rejects(
    () => writeTextFile({ root, file: 'README.md', content: 'x', overwrite: false }),
    /already exists/,
  );
});

test('the write keeps the old version in the backup', async () => {
  const root = await sampleProject();
  const backupDir = path.join(root, '.backup');
  const out = await writeTextFile({ root, file: 'README.md', content: '# New\n', backupDir });
  assert.ok(out.backupPath);
  assert.match(await readFile(out.backupPath, 'utf8'), /# Project/);
});

test('the write refuses a secret', async () => {
  const root = await sampleProject();
  await assert.rejects(() => writeTextFile({ root, file: '.env', content: 'X=1' }), /secret/);
});

test('the write outside the root is refused', async () => {
  const root = await tempProject();
  await assert.rejects(() => writeTextFile({ root, file: '../evil.txt', content: 'x' }), /outside/);
});

test('the replace changes one fragment', async () => {
  const root = await sampleProject();
  const out = await replaceInFile({ root, file: 'src/index.js', search: '42', replacement: '43' });
  assert.equal(out.replacements, 1);
  assert.match(await readFile(path.join(root, 'src', 'index.js'), 'utf8'), /43/);
});

test('the replace refuses an ambiguous fragment without all', async () => {
  const root = await sampleProject();
  await writeFile(path.join(root, 'twice.txt'), 'a\na\n', 'utf8');
  await assert.rejects(
    () => replaceInFile({ root, file: 'twice.txt', search: 'a', replacement: 'b' }),
    /occurs/,
  );
});

test('the replace with all changes every occurrence', async () => {
  const root = await sampleProject();
  await writeFile(path.join(root, 'twice.txt'), 'a\na\n', 'utf8');
  const out = await replaceInFile({ root, file: 'twice.txt', search: 'a', replacement: 'b', all: true });
  assert.equal(out.replacements, 2);
  assert.equal(await readFile(path.join(root, 'twice.txt'), 'utf8'), 'b\nb\n');
});

test('the replace of a missing fragment fails', async () => {
  const root = await sampleProject();
  await assert.rejects(
    () => replaceInFile({ root, file: 'src/index.js', search: 'nothing', replacement: 'x' }),
    /not found/,
  );
});

test('the delete removes the file and keeps a backup', async () => {
  const root = await sampleProject();
  const backupDir = path.join(root, '.backup');
  const out = await deleteFile({ root, file: 'src/index.js', backupDir });
  assert.equal(out.rel, 'src/index.js');
  await assert.rejects(() => readFile(path.join(root, 'src', 'index.js')), /ENOENT/);
  assert.ok(out.backupPath);
});

test('the delete refuses a directory', async () => {
  const root = await sampleProject();
  await assert.rejects(() => deleteFile({ root, file: 'src' }), /Only a file/);
});

test('the mkdir creates the tree', async () => {
  const root = await tempProject();
  const out = await makeDirectory({ root, dir: 'a/b/c' });
  assert.equal(out.rel, 'a/b/c');
  assert.equal((await stat(path.join(root, 'a', 'b', 'c'))).isDirectory(), true);
});

test('the copy copies a file', async () => {
  const root = await sampleProject();
  const out = await copyPath({ root, source: 'README.md', destination: 'docs/README.md' });
  assert.equal(out.type, 'file');
  assert.equal(await readFile(path.join(root, 'docs', 'README.md'), 'utf8'), '# Project\n\nHello.\n');
});

test('the copy copies a tree', async () => {
  const root = await sampleProject();
  const out = await copyPath({ root, source: 'src', destination: 'lib' });
  assert.equal(out.type, 'directory');
  assert.match(await readFile(path.join(root, 'lib', 'index.js'), 'utf8'), /answer/);
});

test('the copy refuses a destination that exists', async () => {
  const root = await sampleProject();
  await assert.rejects(
    () => copyPath({ root, source: 'README.md', destination: 'src/index.js' }),
    /already exists/,
  );
});

test('the copy refuses a tree with a secret', async () => {
  const root = await sampleProject();
  await mkdir(path.join(root, 'bundle'), { recursive: true });
  await writeFile(path.join(root, 'bundle', '.env'), 'SECRET=1\n', 'utf8');
  await assert.rejects(
    () => copyPath({ root, source: 'bundle', destination: 'copy' }),
    /secret/,
  );
});

test('the catalog holds the file system tools, the terminal ones and the context ones', () => {
  assert.equal(TOOL_NAMES.length, 13);
  for (const name of TOOL_NAMES) assert.ok(TOOL_SPECS[name], name);
  assert.equal(toolCategory('write_file'), 'write');
  assert.equal(toolCategory('read_file'), 'read');
  assert.equal(toolCategory('run_command'), 'exec');
  assert.equal(toolCategory('scan_workspace'), 'read');
  assert.equal(toolRisk('delete_file'), 'high');
  assert.equal(toolCategory('nope'), null);
  assert.equal(describeTool('nope'), null);
  assert.match(describeTool('list_files').description, /List the files/);
  assert.ok(toolsByCategory('read').includes('search_files'));
});

test('the definitions of the tools are ready for the request', () => {
  const defs = toolDefinitions();
  assert.equal(defs.length, 13);
  for (const def of defs) {
    assert.equal(def.type, 'function');
    assert.ok(def.name);
    assert.ok(def.description);
    assert.equal(def.parameters.type, 'object');
    assert.equal(def.parameters.additionalProperties, false);
  }
});

test('the optional fields of the schema are not required', () => {
  assert.deepEqual(TOOL_SPECS.write_file.parameters.required, ['path', 'content']);
  assert.deepEqual(TOOL_SPECS.list_files.parameters.required, ['path']);
});

test('executeTool writes a file', async () => {
  const root = await tempProject();
  const out = await executeTool('write_file', { path: 'a.txt', content: 'hello' }, { root });
  assert.match(out.text, /a\.txt/);
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'hello');
});

test('executeTool reads a file', async () => {
  const root = await sampleProject();
  const out = await executeTool('read_file', { path: 'src/index.js' }, { root });
  assert.match(out.text, /answer = 42/);
});

test('executeTool refuses an unknown tool', async () => {
  const root = await tempProject();
  await assert.rejects(() => executeTool('nope', {}, { root }), /no tool/);
});

test('executeTool refuses an unknown argument', async () => {
  const root = await tempProject();
  await assert.rejects(() => executeTool('read_file', { path: 'a', nope: 1 }, { root }), /no argument/);
});

test('executeTool refuses a missing argument', async () => {
  const root = await tempProject();
  await assert.rejects(() => executeTool('read_file', {}, { root }), /needs the argument/);
});

test('executeTool refuses a wrong type of an argument', async () => {
  const root = await tempProject();
  await assert.rejects(() => executeTool('read_file', { path: 42 }, { root }), /must be string/);
  await assert.rejects(() => executeTool('list_files', { path: '.', depth: 'two' }, { root }), /must be integer/);
});

test('executeTool refuses a path outside the root', async () => {
  const root = await tempProject();
  await assert.rejects(
    () => executeTool('write_file', { path: '../evil.txt', content: 'x' }, { root }),
    /outside/,
  );
});

test('the formatters say the size, the time and the cut', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatDuration(500), '500 ms');
  assert.equal(formatDuration(1500), '1.5 s');
  assert.equal(formatDuration(65_000), '1 m 05 s');
  assert.equal(truncateText('hello', 100).truncated, false);
  assert.equal(truncateText('hello', 2).text, 'he');
  assert.equal(truncateText('hello', 2).truncated, true);
});

test('the temporary project is cleaned up', async () => {
  const root = await tempProject();
  await rm(root, { recursive: true, force: true });
});
