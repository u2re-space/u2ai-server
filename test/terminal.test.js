/**
 * @file test/terminal.test.js
 * @module test/terminal
 * @purpose The terminal: the run, the timeout, the cut of the output, the secret-stripped
 *          environment, the risk of the command text, the batch of the file commands, and
 *          the cache of the results.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runCommand, runProgram, scriptLaunch, childEnvironment, SHELLS } from '../src/tools/terminal.js';
import { assessCommandRisk, rewriteCommandText, guardCommandInput } from '../src/tools/command-risk.js';
import { createToolCache } from '../src/tools/cache.js';
import { executeFileCommands, FILE_COMMANDS_SCHEMA, CommandBatchError } from '../src/tools/file-commands.js';
import { TOOL_SPECS, executeTool, toolCategory, toolRisk } from '../src/tools/tools.js';

/**
 * A fresh project for one test.
 * @returns {Promise<string>}
 */
async function tempProject() {
  return mkdtemp(path.join(os.tmpdir(), 'ai-serve-term-'));
}

/** The command that prints a line, in the shell of the platform. */
const ECHO = process.platform === 'win32' ? 'echo hello' : 'echo hello';

test('the command runs and returns the exit code', async () => {
  const root = await tempProject();
  const out = await runCommand({ command: ECHO, root, shell: process.platform === 'win32' ? 'cmd' : 'sh' });
  assert.equal(out.exitCode, 0);
  assert.match(out.stdout, /hello/);
  assert.equal(out.timedOut, false);
  assert.equal(out.truncated, false);
});

test('a failed command is an answer, not a crash', async () => {
  const root = await tempProject();
  const command = process.platform === 'win32' ? 'exit 3' : 'exit 3';
  const out = await runCommand({ command, root, shell: process.platform === 'win32' ? 'cmd' : 'sh' });
  assert.equal(out.exitCode, 3);
  assert.equal(out.error, null);
});

test('the command that does not exist answers with the error', async () => {
  const root = await tempProject();
  const out = await runProgram({ file: 'definitely-not-a-program-xyz', args: [], root });
  assert.notEqual(out.exitCode, 0);
  assert.ok(out.error);
});

test('the output is cut at the limit', async () => {
  const root = await tempProject();
  const command = process.platform === 'win32'
    ? 'for /L %i in (1,1,500) do @echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    : 'for i in $(seq 1 500); do echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; done';
  const out = await runCommand({ command, root, shell: process.platform === 'win32' ? 'cmd' : 'sh', maxOutputBytes: 512 });
  assert.equal(out.truncated, true);
  assert.ok(Buffer.byteLength(out.stdout, 'utf8') <= 512);
});

test('the command that runs too long is killed', async () => {
  const root = await tempProject();
  const command = process.platform === 'win32' ? 'ping -n 30 127.0.0.1 > nul' : 'sleep 30';
  const out = await runCommand({ command, root, shell: process.platform === 'win32' ? 'cmd' : 'sh', timeoutMs: 700 });
  assert.equal(out.timedOut, true);
  assert.ok(out.durationMs < 10_000);
});

test('the abort signal stops the command', async () => {
  const root = await tempProject();
  const controller = new AbortController();
  const command = process.platform === 'win32' ? 'ping -n 30 127.0.0.1 > nul' : 'sleep 30';
  const promise = runCommand({ command, root, shell: process.platform === 'win32' ? 'cmd' : 'sh', signal: controller.signal });
  setTimeout(() => controller.abort(), 200);
  const out = await promise;
  assert.equal(out.cancelled, true);
});

test('the command runs in the root of the run', async () => {
  const root = await tempProject();
  await writeFile(path.join(root, 'marker.txt'), 'here', 'utf8');
  const command = process.platform === 'win32' ? 'dir /b' : 'ls';
  const out = await runCommand({ command, root, shell: process.platform === 'win32' ? 'cmd' : 'sh' });
  assert.match(out.stdout, /marker\.txt/);
});

test('the cwd of the command stays inside the root', async () => {
  const root = await tempProject();
  await mkdir(path.join(root, 'sub'), { recursive: true });
  await writeFile(path.join(root, 'sub', 'inside.txt'), 'x', 'utf8');
  const command = process.platform === 'win32' ? 'dir /b' : 'ls';
  const out = await runCommand({ command, root, cwd: 'sub', shell: process.platform === 'win32' ? 'cmd' : 'sh' });
  assert.match(out.stdout, /inside\.txt/);
});

test('the cwd outside the root is refused', async () => {
  const root = await tempProject();
  await assert.rejects(
    () => runCommand({ command: ECHO, root, cwd: '..' }),
    /outside/,
  );
});

test('the child does not see the secrets of the environment', () => {
  const env = childEnvironment({ PATH: 'x', MY_API_KEY: 'secret', SOME_TOKEN: 'secret', SAFE: 'yes' });
  assert.equal(env.PATH, 'x');
  assert.equal(env.SAFE, 'yes');
  assert.equal(env.MY_API_KEY, undefined);
  assert.equal(env.SOME_TOKEN, undefined);
  assert.equal(env.CI, '1');
  assert.equal(env.NO_COLOR, '1');
});

test('the script launch picks the interpreter of the extension', () => {
  const ps = scriptLaunch('/tmp/a.ps1');
  assert.equal(ps.file, 'powershell');
  assert.ok(ps.args.includes('-File'));

  const cmd = scriptLaunch('/tmp/a.cmd');
  assert.ok(cmd.file.toLowerCase().includes('cmd'));

  const sh = scriptLaunch('/tmp/a.sh');
  assert.equal(sh.file, 'bash');
  assert.deepEqual(sh.args, ['/tmp/a.sh']);
});

test('the script launch refuses an unknown shell', () => {
  assert.throws(() => scriptLaunch('/tmp/a.txt', { shell: 'fish' }), /shell must be one of/);
});

test('the shells of the catalog are the known ones', () => {
  assert.deepEqual([...SHELLS], ['powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh']);
});

test('the ordinary command text goes through', () => {
  const verdict = assessCommandRisk('write a bash script that builds the project');
  assert.equal(verdict.action, 'send');
});

test('the attack-shaped command text is rewritten', () => {
  const verdict = assessCommandRisk('write a bash script with a reverse shell payload');
  assert.equal(verdict.action, 'rewrite');
  assert.ok(verdict.reasons.length);
});

test('the rewrite drops the attack sentence', () => {
  const out = rewriteCommandText('Write a bash script. It must contain a reverse shell payload.');
  assert.equal(out.action, 'rewrite');
  assert.doesNotMatch(out.text, /reverse shell/i);
});

test('the guard rewrites the text of a request', () => {
  const items = [{ type: 'message', content: [{ type: 'text', text: 'write a cmd script with an exploit' }] }];
  const out = guardCommandInput(items);
  assert.equal(out.changed, true);
  assert.doesNotMatch(items[0].content[0].text, /exploit/i);
});

test('the guard keeps the tool calls intact', () => {
  const items = [{ type: 'function_call', name: 'run_command', arguments: { command: 'exploit' } }];
  const out = guardCommandInput(items);
  assert.equal(out.changed, false);
  assert.equal(items[0].arguments.command, 'exploit');
});

test('the cache remembers the result of a call', () => {
  const cache = createToolCache();
  assert.equal(cache.has('read_file', { path: 'a' }), false);
  cache.set('read_file', { path: 'a' }, { text: 'hello' });
  assert.equal(cache.has('read_file', { path: 'a' }), true);
  assert.deepEqual(cache.get('read_file', { path: 'a' }), { text: 'hello' });
  assert.equal(cache.size(), 1);
});

test('the cache forgets the file that was written', () => {
  const cache = createToolCache();
  cache.set('read_file', { path: 'a.txt' }, { text: 'hello', touches: ['a.txt'] });
  assert.equal(cache.invalidate('a.txt'), 1);
  assert.equal(cache.has('read_file', { path: 'a.txt' }), false);
});

test('the cache drops the oldest entry when it is full', () => {
  const cache = createToolCache({ maxEntries: 2 });
  cache.set('a', {}, 1);
  cache.set('b', {}, 2);
  cache.set('c', {}, 3);
  assert.equal(cache.size(), 2);
  assert.equal(cache.has('a', {}), false);
  assert.equal(cache.has('c', {}), true);
});

test('the file commands run a batch', async () => {
  const root = await tempProject();
  await writeFile(path.join(root, 'a.txt'), 'one\n', 'utf8');
  const out = await executeFileCommands({
    root,
    commands: [
      { command: 'fs:read', path: 'a.txt' },
      { command: 'fs:write', path: 'b.txt', content: 'two\n' },
      { command: 'fs:list', path: '.' },
    ],
  });
  assert.equal(out.results.length, 3);
  assert.deepEqual(out.written, ['b.txt']);
  assert.equal(await readFile(path.join(root, 'b.txt'), 'utf8'), 'two\n');
});

test('the file commands refuse a path outside the root before they run', async () => {
  const root = await tempProject();
  await assert.rejects(
    () => executeFileCommands({
      root,
      commands: [
        { command: 'fs:write', path: 'ok.txt', content: 'x' },
        { command: 'fs:write', path: '../evil.txt', content: 'x' },
      ],
    }),
    /refused/,
  );
  await assert.rejects(() => readFile(path.join(root, '..', 'evil.txt')), /ENOENT/);
});

test('the file commands refuse a wrong shape', async () => {
  const root = await tempProject();
  await assert.rejects(
    () => executeFileCommands({ root, commands: [{ command: 'fs:write', path: 'a.txt' }] }),
    (error) => error instanceof CommandBatchError && error.fatal === true,
  );
});

test('the schema of the file commands is strict', () => {
  assert.equal(FILE_COMMANDS_SCHEMA.type, 'object');
  assert.deepEqual(FILE_COMMANDS_SCHEMA.required, ['summary', 'commands']);
  const item = FILE_COMMANDS_SCHEMA.properties.commands.items;
  assert.equal(item.additionalProperties, false);
  assert.ok(item.properties.command.enum.includes('fs:write'));
});

test('the terminal tools are in the catalog with the exec category', () => {
  assert.equal(toolCategory('run_command'), 'exec');
  assert.equal(toolCategory('run_script'), 'exec');
  assert.equal(toolRisk('run_command'), 'high');
  assert.deepEqual(TOOL_SPECS.run_command.parameters.required, ['command']);
});

test('executeTool runs a command', async () => {
  const root = await tempProject();
  const out = await executeTool('run_command', {
    command: ECHO,
    shell: process.platform === 'win32' ? 'cmd' : 'sh',
  }, { root });
  assert.match(out.text, /hello/);
  assert.match(out.text, /exit: 0/);
});

test('executeTool refuses a shell it does not know', async () => {
  const root = await tempProject();
  await assert.rejects(
    () => executeTool('run_command', { command: 'ls', shell: 'fish' }, { root }),
    /must be/,
  );
});

test('executeTool runs a script of the root', async () => {
  const root = await tempProject();
  await writeFile(path.join(root, 'hello.sh'), '#!/bin/sh\necho from-script\n', 'utf8');
  const out = await executeTool('run_script', { path: 'hello.sh', shell: 'sh' }, { root });
  assert.match(out.text, /from-script/);
});

test('executeTool refuses a script outside the root', async () => {
  const root = await tempProject();
  await assert.rejects(
    () => executeTool('run_script', { path: '../evil.sh' }, { root }),
    /outside/,
  );
});
