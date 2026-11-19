/**
 * @file src/agent/skills.js
 * @module agent/skills
 * @purpose Discover and read the Agent Skills and the role packs of the server.
 *
 *   Standard Agent Skills are directories with a `SKILL.md` inside. They are looked for
 *   in the project (`.agents/skills`, `.koda/skills`, `.claude/skills`, `.rules/skills`),
 *   in the configured skill directory and in the global user directory
 *   (`~/.agents/skills`). The model sees their catalogue and opens one with `read_skill`.
 *
 *   Role packs live in `skills.dir` (`~/.ai-serve/skills` by default). A file named after a
 *   role belongs to that role; `shared.md` belongs to every role. A directory with a
 *   `SKILL.md` may declare its roles in the frontmatter. Their text is appended to the
 *   instructions of the role.
 *
 * @depends node:path, node:fs/promises
 * @usedBy roles/index, tools/tools, server/agent, server/mcp
 * @exports parseFrontmatter, skillsDirectory, skillDirectories, discoverSkills,
 *          buildSkillInstructions, readSkill, loadRolePacks, skillsForRole
 * @ai.tags skills, prompts
 * @ai.hint io
 */

import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';

/** The marker of the frontmatter of a skill file. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Split the frontmatter of a markdown file from its body.
 *
 * The parser understands the simple `key: value` lines and the folded (`>`) and literal
 * (`|`) block scalars used by the long descriptions of Agent Skills.
 * @param {string} text
 * @returns {{ meta: Record<string, string>, body: string }}
 * @exports
 * @ai.hint pure
 */
export function parseFrontmatter(text) {
    const source = typeof text === 'string' ? text : '';
    const match = FRONTMATTER_RE.exec(source);
    if (!match) return { meta: {}, body: source };
    const meta = {};
    const lines = match[1].split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
        const colon = lines[index].indexOf(':');
        if (colon < 0) continue;
        const key = lines[index].slice(0, colon).trim();
        if (!key) continue;
        let value = lines[index].slice(colon + 1).trim().replace(/^["']|["']$/g, '');
        if (value === '>' || value === '|' || value === '>-' || value === '|-') {
            const fold = value[0] === '>';
            const parts = [];
            while (index + 1 < lines.length && (/^[ \t]/.test(lines[index + 1]) || lines[index + 1] === '')) {
                parts.push(lines[++index].replace(/^[ \t]+/, ''));
            }
            while (parts.length && parts[parts.length - 1] === '') parts.pop();
            value = fold ? parts.join(' ').replace(/\s+/g, ' ').trim() : parts.join('\n');
        }
        meta[key] = value;
    }
    return { meta, body: source.slice(match[0].length) };
}

/**
 * The directory of the role packs.
 * @param {object|null} config
 * @returns {string|null}
 * @exports
 * @ai.hint pure
 */
export function skillsDirectory(config = null) {
    const configured = typeof config?.skills?.dir === 'string' ? config.skills.dir.trim() : '';
    if (configured) return path.resolve(configured);
    const home = typeof config?.home === 'string' ? config.home.trim() : '';
    return home ? path.join(home, 'skills') : null;
}

/**
 * The standard Agent Skills directories, in precedence order.
 * @param {string} root
 * @param {{ env?: object, extraDirs?: string[] }} [options]
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function skillDirectories(root, { env = process.env, extraDirs = [] } = {}) {
    const home = env.HOME || env.USERPROFILE || '';
    return [
        path.join(root, '.agents', 'skills'),
        path.join(root, '.koda', 'skills'),
        path.join(root, '.claude', 'skills'),
        path.join(root, '.rules', 'skills'),
        ...(Array.isArray(extraDirs) ? extraDirs.filter(Boolean) : []),
        path.join(home, '.agents', 'skills'),
    ];
}

/**
 * Read the Agent Skills of one directory.
 * @param {string} dir
 * @returns {Promise<Array<{name: string, description: string, body: string, path: string, metadata: object}>>}
 * @ai.hint io
 */
async function discoverInDir(dir) {
    const skills = [];
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const file = path.join(dir, entry.name, 'SKILL.md');
        const raw = await readFile(file, 'utf8').catch(() => null);
        if (raw === null) continue;
        const { meta, body } = parseFrontmatter(raw);
        if (!body.trim()) continue;
        skills.push({
            name: meta.name || entry.name,
            description: meta.description || '',
            body: body.trim(),
            path: file,
            metadata: meta,
        });
    }
    return skills;
}

/**
 * Discover the installed Agent Skills without repeats.
 * @param {string} root
 * @param {{ env?: object, extraDirs?: string[] }} [options]
 * @returns {Promise<Array<{name: string, description: string, body: string, path: string, metadata: object}>>}
 * @exports
 * @ai.hint io
 */
export async function discoverSkills(root, { env = process.env, extraDirs = [] } = {}) {
    const found = [];
    const seen = new Set();
    for (const dir of skillDirectories(root, { env, extraDirs })) {
        for (const skill of await discoverInDir(dir)) {
            if (seen.has(skill.name)) continue;
            seen.add(skill.name);
            found.push(skill);
        }
    }
    return found;
}

/**
 * Build the catalogue of the installed skills for the instructions of a role.
 * @param {Array<{name: string, description: string}>} skills
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function buildSkillInstructions(skills = []) {
    const list = Array.isArray(skills) ? skills : [];
    if (!list.length) return '';
    return [
        '# Available skills',
        '',
        'These skills are installed. Read the relevant one with the `read_skill` tool before you use it.',
        '',
        ...list.map((skill) => `- **\`${skill.name}\`**: ${skill.description || 'no description'}`),
    ].join('\n');
}

/**
 * Read one installed Agent Skill by name.
 * @param {string} name
 * @param {string} root
 * @param {{ env?: object, extraDirs?: string[] }} [options]
 * @returns {Promise<{name: string, description: string, body: string, path: string, metadata: object}|null>}
 * @exports
 * @ai.hint io
 */
export async function readSkill(name, root, { env = process.env, extraDirs = [] } = {}) {
    const wanted = String(name ?? '').trim();
    if (!wanted || !/^[\w.-]+$/.test(wanted)) return null;
    const skills = await discoverSkills(root, { env, extraDirs });
    return skills.find((skill) => skill.name === wanted) ?? null;
}

/**
 * Whether a role pack belongs to a role.
 * @param {{ meta: object, source: string }} pack
 * @param {string|null} role
 * @returns {boolean}
 * @ai.hint pure
 */
function belongsTo(pack, role) {
    if (!role) return true;
    const declared = String(pack?.meta?.roles ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    if (declared.length) return declared.includes(role) || declared.includes('*');
    return pack?.source === role || pack?.source === 'shared' || pack?.source === '_shared';
}

/**
 * Read one markdown file as a role pack.
 * @param {string} abs
 * @param {string} source
 * @returns {Promise<{name: string, meta: object, content: string, source: string, files: string[]}|null>}
 * @ai.hint io
 */
async function readPackFile(abs, source) {
    const raw = await readFile(abs, 'utf8').catch(() => null);
    if (raw === null) return null;
    const { meta, body } = parseFrontmatter(raw);
    return {
        name: meta.name || source,
        meta,
        content: body.trim(),
        source,
        files: [path.basename(abs)],
    };
}

/**
 * Read one directory as a role pack.
 * @param {string} dir
 * @param {string} source
 * @returns {Promise<object|null>}
 * @ai.hint io
 */
async function readPackDir(dir, source) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const files = entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
        .map((entry) => entry.name)
        .sort();
    if (!files.length) return null;
    const main = files.find((file) => file.toLowerCase() === 'skill.md')
        ?? files.find((file) => file.toLowerCase() === 'index.md')
        ?? files[0];
    const head = await readPackFile(path.join(dir, main), source);
    if (!head) return null;
    const parts = [head.content];
    const used = [main];
    for (const file of files) {
        if (file === main) continue;
        const extra = await readPackFile(path.join(dir, file), file.slice(0, -3));
        if (!extra) continue;
        used.push(file);
        parts.push(`### ${file}\n${extra.content}`);
    }
    return {
        name: head.name,
        meta: head.meta,
        content: parts.filter(Boolean).join('\n\n'),
        source,
        files: used,
    };
}

/**
 * Load the role packs of one directory.
 * @param {{ dir?: string|null, role?: string|null }} [options]
 * @returns {Promise<Array<object>>}
 * @exports
 * @ai.hint io
 */
export async function loadRolePacks({ dir = null, role = null } = {}) {
    if (!dir) return [];
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const packs = [];
    for (const entry of entries) {
        if (entry.isDirectory()) {
            const pack = await readPackDir(path.join(dir, entry.name), entry.name);
            if (pack) packs.push(pack);
            continue;
        }
        if (!entry.name.endsWith('.md')) continue;
        const pack = await readPackFile(path.join(dir, entry.name), entry.name.slice(0, -3));
        if (pack) packs.push(pack);
    }
    return packs.filter((pack) => belongsTo(pack, role));
}

/**
 * The role packs of one role, ready for the instructions.
 * @param {{ dir?: string|null, role?: string|null }} [options]
 * @returns {Promise<string>}
 * @exports
 * @ai.hint io
 */
export async function skillsForRole(options = {}) {
    const packs = await loadRolePacks(options);
    if (!packs.length) return '';
    return packs
        .map((pack) => `## Skill pack: ${pack.name}\n${pack.content.trim()}`)
        .join('\n\n');
}
