/**
 * @file test/roles.test.js
 * @module test/roles
 * @purpose The roles of the server: the settings of a role, the analysis of a task, the
 *          plan of the work, the choice and the call of a tool, the execution of the
 *          steps, the answer of the suggester, the limit of the turns, and the callable.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ROLE_NAMES,
  ROLE_PROMPTS,
  resolveRoleSettings,
  roleToolNames,
  createRoleAsk,
  runRole,
  runAgent,
} from '../src/roles/index.js';
import { ANALYZER_SCHEMA, analyzerPrompt, shapeAnalysis } from '../src/roles/analyzer.js';
import { DIRECTOR_SCHEMA, shapePlan } from '../src/roles/director.js';
import { EXECUTOR_SCHEMA, shapeStepReport } from '../src/roles/executor.js';
import { TOOLER_SCHEMA, parseToolArguments, toolerPrompt, allowedToolNames } from '../src/roles/tooler.js';
import { SUGGESTER_SCHEMA, shapeSuggestion } from '../src/roles/suggester.js';
import { runCallable } from '../src/agent/callable.js';
import { toolAllowed } from '../src/tools/tools.js';

/**
 * A fresh project for one test.
 * @returns {Promise<string>}
 */
async function tempProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ai-serve-roles-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', main: 'src/index.js' }), 'utf8');
  await writeFile(path.join(root, 'src', 'index.js'), 'export const answer = 42;\n', 'utf8');
  return root;
}

/**
 * A response of the model that calls the tool of the schema.
 * @param {string} name the name of the tool
 * @param {object} args the arguments of the call
 * @returns {object}
 */
function schemaCall(name, args) {
  return {
    id: `resp_${name}`,
    output: [{
      type: 'function_call',
      call_id: `call_${name}`,
      name,
      arguments: JSON.stringify(args),
    }],
  };
}

/**
 * A response of the model with a text.
 * @param {string} text
 * @returns {object}
 */
function textAnswer(text) {
  return {
    id: 'resp_text',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
  };
}

/**
 * A client that answers with the given responses, one by one.
 * @param {object[]} answers
 * @returns {{ client: object, calls: object[] }}
 */
function fakeClient(answers) {
  const calls = [];
  let index = 0;
  return {
    calls,
    client: {
      responses: {
        create: async (params) => {
          calls.push(params);
          const answer = answers[Math.min(index, answers.length - 1)];
          index += 1;
          return typeof answer === 'function' ? answer(params) : answer;
        },
      },
    },
  };
}

test('the roles of the package are known', () => {
  assert.deepEqual([...ROLE_NAMES], ['analyzer', 'director', 'executor', 'tooler', 'suggester']);
  for (const role of ROLE_NAMES) assert.ok(ROLE_PROMPTS[role], role);
});

test('the settings of a role come from the role, then the default, then the top level', () => {
  const config = {
    model: 'base-model',
    reasoning: { effort: 'low' },
    roles: {
      default: { effort: 'medium', instructions: 'Be brief.' },
      analyzer: { model: 'analyzer-model' },
    },
  };
  const settings = resolveRoleSettings(config, 'analyzer');
  assert.equal(settings.model, 'analyzer-model');
  assert.equal(settings.effort, 'medium');
  assert.equal(settings.instructions, 'Be brief.');
  const director = resolveRoleSettings(config, 'director');
  assert.equal(director.model, 'base-model');
});

test('the effort of a role is capped by maxEffort', () => {
  const config = { roles: { executor: { effort: 'high', maxEffort: 'low' } } };
  assert.equal(resolveRoleSettings(config, 'executor').effort, 'low');
});

test('the limit of the turns comes from the configuration', () => {
  assert.equal(resolveRoleSettings({ limits: { maxTurns: 5 } }, 'analyzer').maxTurns, 5);
  assert.equal(resolveRoleSettings({}, 'analyzer').maxTurns, 24);
});

test('the tools of the roles follow the configuration', () => {
  const config = { tools: { allowTerminal: false } };
  const analyzer = roleToolNames(config, 'analyzer');
  assert.ok(analyzer.includes('read_file'));
  assert.ok(!analyzer.includes('write_file'));
  const executor = roleToolNames(config, 'executor');
  assert.ok(executor.includes('write_file'));
  assert.ok(!executor.includes('run_command'));
  assert.deepEqual(roleToolNames(config, 'tooler'), []);
});

test('the list of the tools of a role may be narrowed', () => {
  const config = { roles: { analyzer: { tools: ['read_file'] } } };
  assert.deepEqual(roleToolNames(config, 'analyzer'), ['read_file']);
});

test('the configuration decides which tools exist', () => {
  assert.equal(toolAllowed('read_file', { tools: { read: false } }), false);
  assert.equal(toolAllowed('write_file', { tools: { allowWrite: false } }), false);
  assert.equal(toolAllowed('run_command', { tools: { allowTerminal: false } }), false);
  assert.equal(toolAllowed('read_file', {}), true);
  assert.equal(toolAllowed('nope', {}), false);
  assert.ok(!allowedToolNames({ tools: { read: false } }).includes('read_file'));
});

test('the analyzer reads the task and names the files', async () => {
  const root = await tempProject();
  const { client } = fakeClient([schemaCall('analysis', {
    goal: 'Fix the answer',
    kind: 'code',
    summary: 'The task changes the value of the answer.',
    files: [{ path: 'src/index.js', role: 'edit', reason: 'the answer lives here' }],
    risks: ['the tests may fail'],
    questions: [],
  })]);
  const out = await runRole('analyzer', { task: 'fix the answer', config: {}, client, root });
  assert.equal(out.analysis.goal, 'Fix the answer');
  assert.deepEqual(out.analysis.files.map((item) => item.path), ['src/index.js']);
  assert.equal(out.analysis.risks[0], 'the tests may fail');
});

test('the analyzer sends the schema and the context', async () => {
  const { client, calls } = fakeClient([schemaCall('analysis', {
    goal: 'g', kind: 'code', summary: 's', files: [], risks: [], questions: [],
  })]);
  await runRole('analyzer', { task: 'fix the answer', config: {}, client, root: await tempProject() });
  assert.equal(calls[0].schema, ANALYZER_SCHEMA);
  assert.equal(calls[0].schemaName, 'analysis');
  assert.match(JSON.stringify(calls[0].input), /fix the answer/);
});

test('the director writes the plan of the work', async () => {
  const { client, calls } = fakeClient([schemaCall('plan', {
    steps: [{ id: 'one', title: 'Read the file', action: 'read src/index.js', files: ['src/index.js'], verify: 'the answer is read' }],
    risks: [],
    notes: '',
  })]);
  const out = await runRole('director', {
    task: 'fix the answer',
    analysis: { goal: 'Fix the answer' },
    config: {},
    client,
    root: await tempProject(),
  });
  assert.equal(out.plan.steps.length, 1);
  assert.equal(out.plan.steps[0].id, 'one');
  assert.equal(calls[0].schema, DIRECTOR_SCHEMA);
  assert.match(JSON.stringify(calls[0].input), /Fix the answer/);
});

test('the tooler chooses a tool and runs it', async () => {
  const root = await tempProject();
  const { client, calls } = fakeClient([schemaCall('tool_choice', {
    tool: 'read_file',
    arguments: '{"path":"src/index.js"}',
    reason: 'the answer lives in the file',
  })]);
  const out = await runRole('tooler', { task: 'read the answer', config: {}, client, root });
  assert.equal(out.tool, 'read_file');
  assert.deepEqual(out.arguments, { path: 'src/index.js' });
  assert.equal(out.result.ok, true);
  assert.match(out.result.text, /answer = 42/);
  assert.equal(calls[0].schema, TOOLER_SCHEMA);
});

test('the tooler keeps the failure of a tool as a result', async () => {
  const root = await tempProject();
  const { client } = fakeClient([schemaCall('tool_choice', {
    tool: 'read_file',
    arguments: '{"path":"nope.txt"}',
    reason: 'the file is missing',
  })]);
  const out = await runRole('tooler', { task: 'read the answer', config: {}, client, root });
  assert.equal(out.result.ok, false);
  assert.match(out.result.error, /not found/i);
});

test('the arguments of a tool are read as a JSON object', () => {
  assert.deepEqual(parseToolArguments('{"a":1}'), { a: 1 });
  assert.deepEqual(parseToolArguments('broken'), {});
  assert.deepEqual(parseToolArguments({ a: 1 }), { a: 1 });
});

test('the prompt of the tooler holds the catalog', () => {
  const text = toolerPrompt({ task: 'read the file', tools: ['read_file'] });
  assert.match(text, /read_file/);
  assert.match(text, /read the file/);
});

test('the executor runs the steps of the plan with the tools', async () => {
  const root = await tempProject();
  const { client, calls } = fakeClient([
    schemaCall('read_file', { path: 'src/index.js' }),
    schemaCall('step_report', { status: 'done', note: 'the file is read', files: [] }),
  ]);
  const out = await runRole('executor', {
    task: 'fix the answer',
    plan: { steps: [{ id: 'one', title: 'Read', action: 'read src/index.js', files: ['src/index.js'], verify: 'read' }] },
    config: {},
    client,
    root,
  });
  assert.equal(out.steps.length, 1);
  assert.equal(out.steps[0].status, 'done');
  assert.equal(out.toolCalls.length, 1);
  assert.equal(out.toolCalls[0].name, 'read_file');
  assert.match(out.toolCalls[0].text, /answer = 42/);
  assert.equal(calls[0].schema, EXECUTOR_SCHEMA);
  assert.equal(calls[1].schemaName, 'step_report');
});

test('the executor reports a failed step and goes on', async () => {
  const root = await tempProject();
  const { client } = fakeClient([
    schemaCall('step_report', { status: 'failed', note: 'the file is missing', files: [] }),
    schemaCall('step_report', { status: 'done', note: 'the second step is done', files: [] }),
  ]);
  const out = await runRole('executor', {
    task: 'fix the answer',
    plan: {
      steps: [
        { id: 'one', title: 'First', action: 'read a missing file', files: [], verify: '' },
        { id: 'two', title: 'Second', action: 'read the file', files: [], verify: '' },
      ],
    },
    config: {},
    client,
    root,
  });
  assert.deepEqual(out.steps.map((item) => item.status), ['failed', 'done']);
  assert.match(out.summary, /1 of 2 steps are done/);
});

test('the suggester answers the question', async () => {
  const { client, calls } = fakeClient([schemaCall('suggestion', {
    answer: 'The answer lives in src/index.js.',
    hints: ['the tests are in test/'],
    paths: ['src/index.js'],
    commands: ['npm test'],
  })]);
  const out = await runRole('suggester', { task: 'where is the answer?', config: {}, client, root: await tempProject() });
  assert.match(out.suggestion.answer, /src\/index\.js/);
  assert.deepEqual(out.suggestion.commands, ['npm test']);
  assert.equal(calls[0].schema, SUGGESTER_SCHEMA);
});

test('the loop of a role stops at the limit of the turns', async () => {
  const root = await tempProject();
  const { client, calls } = fakeClient([schemaCall('read_file', { path: 'src/index.js' })]);
  const ask = createRoleAsk({
    client,
    config: {},
    root,
    tools: ['read_file'],
    maxTurns: 3,
  });
  const out = await ask({ prompt: 'read the file', schema: EXECUTOR_SCHEMA, schemaName: 'step_report' });
  assert.equal(out.limitReached, true);
  assert.equal(out.turns, 3);
  assert.equal(calls.length, 3);
  assert.equal(out.toolCalls.length, 3);
});

test('the loop of a role needs a client', () => {
  assert.throws(() => createRoleAsk({}), /client/);
});

test('the server agent reads the task, plans it and does it', async () => {
  const root = await tempProject();
  const { client, calls } = fakeClient([
    schemaCall('analysis', { goal: 'g', kind: 'code', summary: 's', files: [], risks: [], questions: [] }),
    schemaCall('plan', { steps: [], risks: [], notes: '' }),
  ]);
  const out = await runAgent({ task: 'fix the answer', config: {}, client, root });
  assert.equal(out.analysis.goal, 'g');
  assert.deepEqual(out.plan.steps, []);
  assert.match(out.execution.summary, /no steps/);
  assert.equal(calls.length, 2);
});

test('a callable answers a task with one request', async () => {
  const root = await tempProject();
  const { client, calls } = fakeClient([textAnswer('The answer lives in src/index.js.')]);
  const out = await runCallable({ task: 'where is the answer?', config: {}, client, root });
  assert.match(out.text, /src\/index\.js/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tools, undefined);
  assert.match(JSON.stringify(calls[0].input), /where is the answer/);
});

test('the shapes of the answers keep the fields of the model', () => {
  assert.equal(shapeAnalysis(null).goal, '');
  assert.equal(shapePlan(null).steps.length, 0);
  assert.equal(shapeStepReport({ status: 'weird' }).status, 'failed');
  assert.equal(shapeSuggestion(null).answer, '');
  assert.match(analyzerPrompt({ task: 'x' }), /Task: x/);
});
