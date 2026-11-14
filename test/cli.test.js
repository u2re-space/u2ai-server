/**
 * @file test/cli.test.js
 * @module test/cli
 * @purpose The CLI of the package: the help, the version, the list of the tools, the
 *          configuration, the doctor and the usage errors of the commands.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';

import { main, EXIT, HELP, COMMAND_NAMES } from '../src/index.js';
import { runDoctor, formatDoctor } from '../src/cli/doctor.js';

/**
 * A fresh home directory for one test.
 * @returns {Promise<string>}
 */
async function tempHome() {
    return await mkdtemp(path.join(os.tmpdir(), 'ai-serve-cli-'));
}

/**
 * Run the CLI and keep what it prints.
 * @param {string[]} argv
 * @param {{ home?: string|null, env?: object|null }} [options]
 * @returns {Promise<{ code: number, output: string, error: string }>}
 */
async function runCli(argv, { home = null, env = null } = {}) {
    const saved = {};
    const set = { ...(home ? { AI_SERVE_HOME: home } : {}), ...(env ?? {}) };
    for (const [key, value] of Object.entries(set)) {
        saved[key] = process.env[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    const out = [];
    const err = [];
    const log = console.log;
    const error = console.error;
    console.log = (text) => { out.push(String(text)); };
    console.error = (text) => { err.push(String(text)); };
    try {
        const code = await main(argv);
        return { code, output: out.join('\n'), error: err.join('\n') };
    } finally {
        console.log = log;
        console.error = error;
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

test('the help lists the commands and the options', async () => {
    const answer = await runCli(['--help']);
    assert.equal(answer.code, EXIT.ok);
    assert.match(answer.output, /Usage:/);
    for (const name of COMMAND_NAMES) assert.match(answer.output, new RegExp(name));
    assert.match(answer.output, /--port/);
    assert.equal(HELP, answer.output);
});

test('the version is the version of the package', async () => {
    const answer = await runCli(['--version']);
    assert.equal(answer.code, EXIT.ok);
    assert.match(answer.output.trim(), /^\d+\.\d+\.\d+/);
});

test('an unknown command is a usage error', async () => {
    const answer = await runCli(['nonsense']);
    assert.equal(answer.code, EXIT.usage);
    assert.match(answer.error, /Unknown command: nonsense/);
});

test('the command tools lists the tools of the package', async () => {
    const answer = await runCli(['tools', '--json']);
    assert.equal(answer.code, EXIT.ok);
    const rows = JSON.parse(answer.output);
    assert.ok(rows.length > 5);
    for (const row of rows) {
        assert.equal(typeof row.name, 'string');
        assert.equal(typeof row.category, 'string');
        assert.equal(typeof row.risk, 'string');
    }
    const names = rows.map((row) => row.name);
    assert.ok(names.includes('read_file'));
    assert.ok(names.includes('run_command'));
});

test('the command tools prints a table', async () => {
    const answer = await runCli(['tools']);
    assert.equal(answer.code, EXIT.ok);
    assert.match(answer.output, /read_file/);
});

test('the command config prints the resolved configuration', async () => {
    const home = await tempHome();
    await writeFile(
        path.join(home, 'config.json'),
        JSON.stringify({ model: 'test/model', apiKey: 'sk-secret-value-123456' }),
        'utf8',
    );
    const answer = await runCli(['config'], { home });
    assert.equal(answer.code, EXIT.ok);
    const config = JSON.parse(answer.output);
    assert.equal(config.model, 'test/model');
    assert.equal(config.home, home);
    assert.notEqual(config.apiKey, 'sk-secret-value-123456');
    await rm(home, { recursive: true, force: true });
});

test('the command doctor checks the environment', async () => {
    const home = await tempHome();
    const answer = await runCli(['doctor', '--json'], { home, env: { AI_SERVE_API_KEY: 'sk-test', OPENAI_API_KEY: undefined } });
    assert.equal(answer.code, EXIT.ok);
    const report = JSON.parse(answer.output);
    const names = report.checks.map((item) => item.name);
    for (const name of ['node', 'home', 'config', 'configuration', 'key', 'model', 'port', 'services', 'mcp']) {
        assert.ok(names.includes(name), `the check ${name} is missing`);
    }
    const key = report.checks.find((item) => item.name === 'key');
    assert.equal(key.status, 'ok');
    assert.equal(report.ok, true);
    await rm(home, { recursive: true, force: true });
});

test('the doctor fails without the key of the model', async () => {
    const home = await tempHome();
    const report = await runDoctor({
        cwd: home,
        env: { AI_SERVE_HOME: home, AI_SERVE_API_KEY: '', OPENAI_API_KEY: '' },
    });
    const key = report.checks.find((item) => item.name === 'key');
    assert.equal(key.status, 'fail');
    assert.equal(report.ok, false);
    await rm(home, { recursive: true, force: true });
});

test('the doctor sees a broken configuration', async () => {
    const home = await tempHome();
    await writeFile(path.join(home, 'config.json'), JSON.stringify({ model: 42 }), 'utf8');
    const report = await runDoctor({ cwd: home, env: { AI_SERVE_HOME: home } });
    const configuration = report.checks.find((item) => item.name === 'configuration');
    assert.equal(configuration.status, 'fail');
    assert.equal(report.ok, false);
    await rm(home, { recursive: true, force: true });
});

test('the report of the doctor is a list of checks', () => {
    const text = formatDoctor([
        { name: 'node', status: 'ok', detail: 'v26.0.0' },
        { name: 'key', status: 'fail', detail: 'no key' },
    ]);
    assert.match(text, /ok\s+node\s+v26\.0\.0/);
    assert.match(text, /fail\s+key\s+no key/);
});

test('the command complete needs a file', async () => {
    const answer = await runCli(['complete']);
    assert.equal(answer.code, EXIT.usage);
    assert.match(answer.error, /needs a file/);
});

test('the command complete fails on a file that does not exist', async () => {
    const home = await tempHome();
    const answer = await runCli(['complete', '--file', 'nothing.js', '--line', '1'], { home });
    assert.equal(answer.code, EXIT.failure);
    assert.match(answer.error, /nothing\.js/);
    await rm(home, { recursive: true, force: true });
});

test('the command agent needs a task', async () => {
    const home = await tempHome();
    const answer = await runCli(['agent'], { home });
    assert.equal(answer.code, EXIT.usage);
    assert.match(answer.error, /needs a task/);
    await rm(home, { recursive: true, force: true });
});

test('the command agent refuses an unknown role', async () => {
    const home = await tempHome();
    const answer = await runCli(['agent', 'fix the tests', '--role', 'wizard'], { home });
    assert.equal(answer.code, EXIT.usage);
    assert.match(answer.error, /no role named wizard/);
    await rm(home, { recursive: true, force: true });
});

test('the command services refuses an unknown action', async () => {
    const home = await tempHome();
    const answer = await runCli(['services', 'dance'], { home });
    assert.equal(answer.code, EXIT.usage);
    assert.match(answer.error, /Unknown action/);
    await rm(home, { recursive: true, force: true });
});

test('the command services add needs a name', async () => {
    const home = await tempHome();
    const answer = await runCli(['services', 'add', '--url', 'ws://127.0.0.1:9000'], { home });
    assert.equal(answer.code, EXIT.usage);
    assert.match(answer.error, /needs a name/);
    await rm(home, { recursive: true, force: true });
});
