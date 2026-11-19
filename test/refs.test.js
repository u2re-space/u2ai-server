/**
 * @file test/refs.test.js
 * @module test/refs
 * @purpose Tests of the references to models: the families (the cheapest member answers) and
 *          the groups (the member that fits the work answers).
 * @depends node:test, model/refs, roles/index, openai/fallback
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    familyLadder, familyModels, familyName, groupLadder, groupMembers, groupName, resolveModelRef,
} from '../src/model/refs.js';
import { fallbackChain } from '../src/openai/fallback.js';
import { resolveRoleSettings } from '../src/roles/index.js';
import { defaults } from '../src/config/defaults.js';

const configFor = (overrides = {}) => ({
    ...structuredClone(defaults),
    ...overrides,
});

test('a reference names a family only with the prefix', () => {
    assert.equal(familyName('family:gpt'), 'gpt');
    assert.equal(familyName('family: gpt '), 'gpt');
    assert.equal(familyName('openai/gpt-6.1-terra'), null);
    assert.equal(familyName('gpt'), null);
    assert.equal(familyName('family:'), null);
});

test('a family answers with the cheapest member that takes the effort', () => {
    const config = configFor();
    assert.deepEqual(familyModels(config, 'gpt'), ['openai/gpt-6.1-terra', 'openai/gpt-6.2-sol']);
    assert.equal(resolveModelRef('family:gpt', config), 'openai/gpt-6.1-terra');
    const ladder = {
        ...config,
        modelFamilies: { mixed: ['openai/gpt-6.1-terra', 'openai/gpt-6.1-sol'] },
    };
    assert.equal(resolveModelRef('family:mixed', ladder, { effort: 'high' }), 'openai/gpt-6.1-terra');
    assert.equal(resolveModelRef('family:mixed', ladder, { effort: 'xhigh' }), 'openai/gpt-6.1-sol');
});

test('a reference names a group only with the prefix', () => {
    assert.equal(groupName('group:small'), 'small');
    assert.equal(groupName('group: small '), 'small');
    assert.equal(groupName('small'), null);
    assert.equal(groupName('family:small'), null);
    assert.equal(groupName('group:'), null);
});

test('the group of the house is a list of members with the limits of their context', () => {
    const config = configFor();
    const members = groupMembers(config, 'small');
    assert.deepEqual(members.map((item) => item.model), [
        'openai/gpt-6-luna',
        'anthropic/claude-haiku-5.5',
        'google/gemini-3.8-flash',
        'minimax/minimax-m3.1-flash',
        'z-ai/glm-5.3-flashx',
    ]);
    assert.equal(members[1].maxContext, 100_000);
    assert.equal(members[0].maxContext, null);
    assert.deepEqual(groupMembers(config, 'nothing'), []);
});

test('a group answers with the first member that takes the effort', () => {
    const config = configFor();
    assert.equal(resolveModelRef('group:small', config), 'openai/gpt-6-luna');
    assert.equal(resolveModelRef('group:small', config, { effort: 'low' }), 'openai/gpt-6-luna');
});

test('a member with a limit of the context is not asked with a big one', () => {
    const only = {
        ...configFor(),
        modelGroups: { small: [{ model: 'anthropic/claude-haiku-5.5', maxContext: 100_000 }] },
    };
    assert.equal(resolveModelRef('group:small', only, { context: 'small' }), 'anthropic/claude-haiku-5.5');
    assert.equal(resolveModelRef('group:small', only, { context: 'max' }), 'anthropic/claude-haiku-5.5',
        'no member fits, so the first one answers anyway');
});

test('the peers of the group stand behind the model in the chain of the fallback', () => {
    const config = configFor();
    assert.deepEqual(
        groupLadder(config, 'openai/gpt-6-luna'),
        ['anthropic/claude-haiku-5.5', 'google/gemini-3.8-flash', 'minimax/minimax-m3.1-flash', 'z-ai/glm-5.3-flashx'],
    );
    assert.ok(fallbackChain(config, 'openai/gpt-6-luna').includes('anthropic/claude-haiku-5.5'));
    // A model of no group keeps the chain of the house.
    assert.deepEqual(familyLadder(config, 'openai/gpt-6-luna'), []);
});

test('the small actions of the service answer on the group of the small models', () => {
    const config = configFor();
    assert.equal(defaults.completion.model, 'group:small');
    assert.equal(defaults.roles.suggester.model, 'group:small');
    assert.equal(resolveRoleSettings(config, 'suggester').model, 'openai/gpt-6-luna');
    // The other roles keep the model of the run.
    assert.equal(resolveRoleSettings(config, 'executor').model, 'minimax/minimax-m3.1-flash');
});
