/**
 * @file test/http.test.js
 * @module test/http
 * @purpose The HTTP part of the server: the routes, the codes, the token, the CORS and the
 *          limit of the body.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';

import { startServe } from '../src/server/serve.js';
import { createHttpHandler, checkToken, requestToken, readJsonBody, corsHeaders, HTTP_ROUTES } from '../src/server/http.js';

/**
 * A fresh home directory for one test.
 * @returns {Promise<string>}
 */
async function tempHome() {
  return await mkdtemp(path.join(os.tmpdir(), 'ai-serve-http-'));
}

/**
 * The answer of an HTTP request of the server.
 * @param {string} url
 * @param {{ method?: string, token?: string, body?: object|string, headers?: object }} [options]
 * @returns {Promise<{ status: number, json: object, headers: Headers }>}
 */
async function request(url, { method = 'GET', token = null, body = null, headers = {} } = {}) {
  const all = { ...headers };
  if (token) all.Authorization = `Bearer ${token}`;
  if (body && typeof body === 'object') {
    all['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const answer = await fetch(url, { method, headers: all, body: body ?? undefined });
  const raw = await answer.text();
  let json = null;
  try { json = JSON.parse(raw); } catch { json = { raw }; }
  return { status: answer.status, json, headers: answer.headers };
}

/**
 * A running server for one test.
 * @param {object} [options]
 * @returns {Promise<object>}
 */
async function server(options = {}) {
  const home = await tempHome();
  return await startServe({ home, port: 0, ...options });
}

test('the routes of the server are known', () => {
  const paths = HTTP_ROUTES.map((route) => `${route.method} ${route.path}`);
  assert.ok(paths.includes('GET /health'));
  assert.ok(paths.includes('GET /v1/tools'));
  assert.ok(paths.includes('GET /v1/serves'));
  assert.ok(paths.includes('POST /v1/complete'));
  assert.ok(paths.includes('POST /v1/structure'));
});

test('the health route is open', async () => {
  const handle = await server();
  const answer = await request(`${handle.httpURL}/health`);
  assert.equal(answer.status, 200);
  assert.equal(answer.json.status, 'ok');
  assert.equal(answer.json.pid, process.pid);
  await handle.close();
});

test('the routes under /v1 need the token', async () => {
  const handle = await server();
  for (const route of ['/v1/tools', '/v1/serves']) {
    const answer = await request(`${handle.httpURL}${route}`);
    assert.equal(answer.status, 401);
    assert.equal(answer.json.error.code, 'unauthorized');
  }
  await handle.close();
});

test('the token is taken from the header and from the query', async () => {
  const handle = await server();
  const header = await request(`${handle.httpURL}/v1/tools`, { token: handle.token });
  assert.equal(header.status, 200);
  const query = await request(`${handle.httpURL}/v1/tools?token=${handle.token}`);
  assert.equal(query.status, 200);
  const wrong = await request(`${handle.httpURL}/v1/tools?token=nope`);
  assert.equal(wrong.status, 401);
  await handle.close();
});

test('the token is taken from the custom header too', async () => {
  const handle = await server();
  const answer = await request(`${handle.httpURL}/v1/tools`, { headers: { 'X-AI-Serve-Token': handle.token } });
  assert.equal(answer.status, 200);
  await handle.close();
});

test('the list of the tools is the one of the server', async () => {
  const handle = await server({ tools: [{ name: 'read_file', category: 'read', risk: 'low' }] });
  const answer = await request(`${handle.httpURL}/v1/tools`, { token: handle.token });
  assert.equal(answer.status, 200);
  assert.equal(answer.json.tools.length, 1);
  assert.equal(answer.json.tools[0].name, 'read_file');
  await handle.close();
});

test('the list of the servers holds this server and the configured ones', async () => {
  const handle = await server({
    config: { services: [{ name: 'other', url: 'ws://127.0.0.1:9999' }] },
  });
  const answer = await request(`${handle.httpURL}/v1/serves`, { token: handle.token });
  assert.equal(answer.status, 200);
  assert.equal(answer.json.serves.length, 2);
  assert.equal(answer.json.serves[0].name, 'self');
  assert.equal(answer.json.serves[0].status, 'running');
  assert.equal(answer.json.serves[1].name, 'other');
  assert.equal(answer.json.serves[1].status, 'configured');
  await handle.close();
});

test('the completion route answers with the text', async () => {
  const handle = await server({ onComplete: async (frame) => ({ id: frame.id, text: 'const b = 2;' }) });
  const body = { id: 'c1', content: 'const a = 1;\n', cursor: { line: 0, character: 12 } };
  const answer = await request(`${handle.httpURL}/v1/complete`, { method: 'POST', token: handle.token, body });
  assert.equal(answer.status, 200);
  assert.equal(answer.json.text, 'const b = 2;');
  await handle.close();
});

test('the completion route refuses a frame that is broken', async () => {
  const handle = await server({ onComplete: async () => ({ text: 'never' }) });
  const answer = await request(`${handle.httpURL}/v1/complete`, {
    method: 'POST',
    token: handle.token,
    body: { id: 'c1', content: 'x' },
  });
  assert.equal(answer.status, 400);
  assert.equal(answer.json.error.code, 'bad_request');
  await handle.close();
});

test('the completion route answers 501 when the bridge is not running', async () => {
  const handle = await server();
  const body = { id: 'c1', content: 'x', cursor: { line: 0, character: 0 } };
  const answer = await request(`${handle.httpURL}/v1/complete`, { method: 'POST', token: handle.token, body });
  assert.equal(answer.status, 501);
  assert.equal(answer.json.error.code, 'not_implemented');
  await handle.close();
});

test('the structure route is a stub', async () => {
  const handle = await server();
  const answer = await request(`${handle.httpURL}/v1/structure`, { method: 'POST', token: handle.token, body: { path: 'a.js' } });
  assert.equal(answer.status, 501);
  assert.equal(answer.json.error.code, 'not_implemented');
  await handle.close();
});

test('the structure route calls the bridge when it is there', async () => {
  const handle = await server({ onStructure: async (body) => ({ structure: { path: body.path } }) });
  const answer = await request(`${handle.httpURL}/v1/structure`, { method: 'POST', token: handle.token, body: { path: 'a.js' } });
  assert.equal(answer.status, 200);
  assert.equal(answer.json.structure.path, 'a.js');
  await handle.close();
});

test('the wrong method of a route is refused', async () => {
  const handle = await server();
  const answer = await request(`${handle.httpURL}/v1/tools`, { method: 'POST', token: handle.token, body: {} });
  assert.equal(answer.status, 405);
  assert.equal(answer.json.error.code, 'method_not_allowed');
  await handle.close();
});

test('the body of a request is limited', async () => {
  const handle = await server({
    config: { limits: { maxBodyBytes: 1024 } },
    onComplete: async () => ({ text: '' }),
  });
  const big = 'x'.repeat(64 * 1024);
  const answer = await request(`${handle.httpURL}/v1/complete`, {
    method: 'POST',
    token: handle.token,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'c1', content: big, cursor: { line: 0, character: 0 } }),
  });
  assert.equal(answer.status, 413);
  assert.equal(answer.json.error.code, 'too_large');
  await handle.close();
});

test('the body that is not JSON is refused', async () => {
  const handle = await server();
  const answer = await request(`${handle.httpURL}/v1/complete`, {
    method: 'POST',
    token: handle.token,
    headers: { 'Content-Type': 'application/json' },
    body: '{broken',
  });
  assert.equal(answer.status, 400);
  assert.equal(answer.json.error.code, 'bad_json');
  await handle.close();
});

test('the CORS headers are on every answer', async () => {
  const handle = await server();
  const answer = await request(`${handle.httpURL}/health`);
  assert.equal(answer.headers.get('access-control-allow-origin'), '*');
  assert.match(answer.headers.get('access-control-allow-methods') ?? '', /POST/);
  await handle.close();
});

test('the preflight of the browser is answered', async () => {
  const handle = await server();
  const answer = await request(`${handle.httpURL}/v1/complete`, { method: 'OPTIONS' });
  assert.equal(answer.status, 204);
  assert.equal(answer.headers.get('access-control-allow-origin'), '*');
  await handle.close();
});

test('an unknown path is left to the caller', async () => {
  const handle = await server();
  const answer = await request(`${handle.httpURL}/nope`);
  assert.equal(answer.status, 426);
  assert.equal(answer.json.error.code, 'upgrade_required');
  await handle.close();
});

test('the token of a request is read from every place', () => {
  assert.equal(requestToken({ headers: { authorization: 'Bearer abc' } }), 'abc');
  assert.equal(requestToken({ headers: { authorization: 'abc' } }), 'abc');
  assert.equal(requestToken({ headers: { 'x-ai-serve-token': 'abc' } }), 'abc');
  assert.equal(requestToken({ url: '/v1/tools?token=abc' }), 'abc');
  assert.equal(requestToken({ url: '/v1/tools' }), null);
  assert.equal(checkToken({ headers: {} }, ['abc']), false);
  assert.equal(checkToken({ headers: {} }, []), true);
});

test('the body is read as a JSON object', async () => {
  const chunks = [Buffer.from('{"a":1}')];
  const req = {
    async *[Symbol.asyncIterator]() { yield* chunks; },
  };
  const answer = await readJsonBody(req);
  assert.equal(answer.ok, true);
  assert.deepEqual(answer.value, { a: 1 });
});

test('the CORS headers are the ones of the local extensions', () => {
  const headers = corsHeaders();
  assert.equal(headers['Access-Control-Allow-Origin'], '*');
  assert.match(headers['Access-Control-Allow-Headers'], /Authorization/);
});
