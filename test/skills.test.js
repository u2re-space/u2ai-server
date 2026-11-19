/**
 * @file test/skills.test.js
 * @module test/skills
 * @purpose Tests of the Agent Skills and the role packs of the server.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    buildSkillInstructions,
    discoverSkills,
    loadRolePacks,
    parseFrontmatter,
    readSkill,
    skillsForRole,
} from '../src/agent/skills.js';
import { executeTool } from '../src/tools/tools.js';

async function tempDir(prefix = 'ai-serve-skills-') {
    return await mkdtemp(path.join(os.tmpdir(), prefix));
}

test('a block scalar keeps the full description', () => {
    const { meta } = parseFrontmatter('---\nname: Pack\ndescription: >\n  First line.\n  Second line.\n---\nBody.');
    assert.equal(meta.description, 'First line. Second line.');
});

test('the Agent Skills of the project are discovered and read', async () => {
    const root = await tempDir();
    const home = await tempDir('ai-serve-home-');
    const skillDir = path.join(root, '.agents', 'skills', 'oil-ui');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: oil-ui\ndescription: UI design workflow.\n---\nChoose a clear visual direction.',
        'utf8',
    );

    const skills = await discoverSkills(root, { env: { HOME: home } });
    assert.deepEqual(skills.map((skill) => skill.name), ['oil-ui']);
    assert.match(buildSkillInstructions(skills), /read_skill/);

    const skill = await readSkill('oil-ui', root, { env: { HOME: home } });
    assert.match(skill.body, /visual direction/);
    assert.equal(await readSkill('../outside', root, { env: { HOME: home } }), null);
});

test('the role packs belong to their roles', async () => {
    const dir = await tempDir('ai-serve-packs-');
    await writeFile(path.join(dir, 'shared.md'), 'Shared rule.', 'utf8');
    await writeFile(path.join(dir, 'executor.md'), 'Executor rule.', 'utf8');
    await mkdir(path.join(dir, 'house-style'), { recursive: true });
    await writeFile(
        path.join(dir, 'house-style', 'SKILL.md'),
        '---\nname: House style\nroles: director\n---\nHouse rule.',
        'utf8',
    );

    const director = await loadRolePacks({ dir, role: 'director' });
    assert.ok(director.some((pack) => pack.content.includes('Shared rule.')));
    assert.ok(director.some((pack) => pack.content.includes('House rule.')));
    assert.ok(!director.some((pack) => pack.content.includes('Executor rule.')));

    const text = await skillsForRole({ dir, role: 'executor' });
    assert.match(text, /Executor rule/);
    assert.match(text, /Shared rule/);
});

test('the read_skill tool opens an installed skill', async () => {
    const root = await tempDir();
    const skillDir = path.join(root, '.agents', 'skills', 'unslop');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: unslop\ndescription: Remove AI design tells.\n---\nAudit the screen.',
        'utf8',
    );

    const out = await executeTool('read_skill', { name: 'unslop' }, { root, config: {} });
    assert.match(out.text, /Audit the screen/);
    assert.equal(out.data.data.name, 'unslop');
});
