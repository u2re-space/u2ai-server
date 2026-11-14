/**
 * @file test/config.test.js
 * @module test/config
 * @purpose The configuration system: precedence, placeholders, paths and the Russian
 *          messages of the validator.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, ensureConfigFile, redactConfig } from '../src/config/index.js';
import { defaults, defaultConfigText } from '../src/config/defaults.js';
import { fromEnv } from '../src/config/env.js';
import { deepMerge } from '../src/config/merge.js';
import { expandPlaceholders, readConfigFile } from '../src/config/parser.js';
import { defaultHome, homeConfigFile, homeMcpFile, serveFile } from '../src/config/paths.js';
import { validateConfig } from '../src/config/validate.js';

/**
 * A fresh home directory for one test.
 * @returns {Promise<string>}
 */
async function tempHome() {
  return mkdtemp(path.join(os.tmpdir(), 'ai-serve-config-'));
}

test('the home directory follows AI_SERVE_HOME', () => {
  assert.equal(defaultHome({ AI_SERVE_HOME: '/tmp/serve' }), path.resolve('/tmp/serve'));
  assert.equal(defaultHome({}), path.join(os.homedir(), '.ai-serve'));
});

test('the home files sit in the home directory', () => {
  const home = '/tmp/serve';
  assert.equal(homeConfigFile(home), path.join(home, 'config.json'));
  assert.equal(homeMcpFile(home), path.join(home, 'mcp.json'));
  assert.equal(serveFile(home), path.join(home, 'serve.json'));
});

test('the environment fills the config', () => {
  const out = fromEnv({
    AI_SERVE_MODEL: 'some/model',
    OPENAI_API_KEY: 'sk-test',
    AI_SERVE_EFFORT: 'high',
    AI_SERVE_PORT: '4321',
    AI_SERVE_APPROVE: 'write',
    AI_SERVE_MCP_TRANSPORT: 'http',
  });
  assert.equal(out.model, 'some/model');
  assert.equal(out.apiKey, 'sk-test');
  assert.equal(out.reasoning.effort, 'high');
  assert.equal(out.server.port, 4321);
  assert.equal(out.server.approve, 'write');
  assert.equal(out.mcp.transport, 'http');
});

test('the environment keeps the OPENAI names as a fallback', () => {
  const out = fromEnv({ OPENAI_BASE_URL: 'https://example.test/v1', OPENAI_MODEL: 'other/model' });
  assert.equal(out.baseURL, 'https://example.test/v1');
  assert.equal(out.model, 'other/model');
});

test('an invalid environment value is ignored', () => {
  const out = fromEnv({ AI_SERVE_PORT: '99999', AI_SERVE_APPROVE: 'maybe', AI_SERVE_EFFORT: 'ultra' });
  assert.equal(out.server, undefined);
  assert.equal(out.reasoning, undefined);
});

test('the placeholders expand', async () => {
  const out = await expandPlaceholders({ key: '{{env:TOKEN}}', other: 'plain' }, { env: { TOKEN: 'abc' } });
  assert.equal(out.key, 'abc');
  assert.equal(out.other, 'plain');
});

test('a missing environment variable expands to an empty string', async () => {
  const out = await expandPlaceholders('{{env:MISSING}}', { env: {} });
  assert.equal(out, '');
});

test('a config file with an unknown section is rejected', async () => {
  const home = await tempHome();
  const file = path.join(home, 'bad.json');
  await writeFile(file, JSON.stringify({ nope: 1 }), 'utf8');
  await assert.rejects(() => readConfigFile(file), /неизвестный раздел/);
});

test('a broken config file is rejected', async () => {
  const home = await tempHome();
  const file = path.join(home, 'bad.json');
  await writeFile(file, '{', 'utf8');
  await assert.rejects(() => readConfigFile(file), /некорректный JSON/);
});

test('the validator speaks Russian', () => {
  const broken = { ...defaults, server: { ...defaults.server, approve: 'maybe' } };
  assert.throws(() => validateConfig(broken), /Конфигурация: server\.approve/);
});

test('the validator refuses a terminal without write access', () => {
  const broken = { ...defaults, tools: { ...defaults.tools, allowWrite: false } };
  assert.throws(() => validateConfig(broken), /tools\.terminal/);
});

test('the loader reads the home config and the environment', async () => {
  const home = await tempHome();
  await mkdir(home, { recursive: true });
  await writeFile(homeConfigFile(home), JSON.stringify({ model: 'home/model' }), 'utf8');
  const config = await loadConfig({ env: { AI_SERVE_HOME: home, AI_SERVE_API_KEY: 'sk-home' } });
  assert.equal(config.model, 'home/model');
  assert.equal(config.apiKey, 'sk-home');
  assert.equal(config.home, home);
});

test('the loader reads the external MCP servers', async () => {
  const home = await tempHome();
  await mkdir(home, { recursive: true });
  await writeFile(homeMcpFile(home), JSON.stringify({ servers: [{ name: 'probe', command: 'node' }] }), 'utf8');
  const config = await loadConfig({ env: { AI_SERVE_HOME: home } });
  assert.equal(config.mcpServers.length, 1);
  assert.equal(config.mcpServers[0].name, 'probe');
});

test('the seeded config file is valid', async () => {
  const home = await tempHome();
  const env = { AI_SERVE_HOME: home };
  const result = await ensureConfigFile(env);
  assert.equal(result.created, true);
  const written = JSON.parse(await readFileText(result.file));
  assert.equal(written.model, defaults.model);
  validateConfig(deepMerge(defaults, written));
});

test('the redact hides the secrets', () => {
  const out = redactConfig({ ...defaults, apiKey: 'sk-1234567890', completion: { ...defaults.completion, tokens: ['token-9876543210'] } });
  assert.ok(!out.apiKey.includes('1234567890'));
  assert.ok(!out.completion.tokens[0].includes('9876543210'));
});

test('the starter config is a JSON object', () => {
  const parsed = JSON.parse(defaultConfigText());
  assert.equal(typeof parsed.model, 'string');
  assert.ok(Array.isArray(parsed.backends));
});

/**
 * Read a file as text.
 * @param {string} file
 * @returns {Promise<string>}
 */
async function readFileText(file) {
  const { readFile } = await import('node:fs/promises');
  return readFile(file, 'utf8');
}
