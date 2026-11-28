/**
 * @file src/tools/tools.js
 * @module tools/tools
 * @purpose The catalog of the tools: the name, the description, the schema of the
 *          parameters, the category and the risk.
 *
 *   The catalog is the single list the model sees, the MCP server publishes, and the
 *   dispatcher runs. A tool that is not in the catalog does not exist for the model, and
 *   the schema of the parameters is the one that is checked before the call.
 *
 *   The category decides the approval: `read` is usually free, `write` asks, `exec` asks
 *   more. The risk says how much the tool may break when it goes wrong.
 *
 * @depends agent/access, tools/filesystem, tools/terminal, tools/cache, shared/format
 * @usedBy agent/roles, server/mcp, server/http
 * @exports TOOL_SPECS, TOOL_NAMES, TOOL_CATEGORIES, TOOL_RISKS, TOOL_ALIASES, toolDefinitions,
 *          describeTool, toolCategory, toolRisk, toolsByCategory, toolAllowed, resolveToolName,
 *          needsApproval, executeToolRequest, executeTool
 * @ai.tags tools, catalog, schema
 * @ai.hint io
 */

import {
    listFiles,
    readTextFile,
    searchFiles,
    writeTextFile,
    replaceInFile,
    deleteFile,
    makeDirectory,
    copyPath,
} from './filesystem.js';
import { runCommand, runProgram, scriptLaunch, SHELLS } from './terminal.js';
import { resolveInside } from '../agent/access.js';
import { scanWorkspace, formatWorkspace } from './context.js';
import { collectRoleContext } from '../agent/context.js';
import { readSkill, skillsDirectory } from '../agent/skills.js';
import { suggest } from './suggest.js';
import { screenshotPage } from './browser.js';
import { createCodeModeRunner } from '../agent/code-mode.js';
import { accessFacilities, accessFacilityDescriptions } from '../access/facility.js';

/** The categories of the tools: they drive the approval. */
export const TOOL_CATEGORIES = Object.freeze(['read', 'write', 'exec']);

/** The risks of the tools: they drive the warning and the limit of the answer. */
export const TOOL_RISKS = Object.freeze(['low', 'medium', 'high']);

/**
 * A string field of a schema.
 * @param {string} description
 * @returns {object}
 * @ai.hint pure
 */
const str = (description) => ({ type: 'string', description });

/**
 * An integer field of a schema that may be null.
 * @param {string} description
 * @returns {object}
 * @ai.hint pure
 */
const nullableInt = (description) => ({ type: ['integer', 'null'], description });

/**
 * A string field of a schema that may be null.
 * @param {string} description
 * @returns {object}
 * @ai.hint pure
 */
const nullableStr = (description) => ({ type: ['string', 'null'], description });

/**
 * A boolean field of a schema.
 * @param {string} description
 * @returns {object}
 * @ai.hint pure
 */
const bool = (description) => ({ type: 'boolean', description });

/**
 * A strict object schema. The properties with a default are optional.
 * @param {object} properties
 * @param {string[]} [optional] the names of the properties that may be omitted
 * @returns {object}
 * @ai.hint pure
 */
const schema = (properties, optional = []) => ({
    type: 'object',
    properties,
    required: Object.keys(properties).filter((key) => !optional.includes(key)),
    additionalProperties: false,
});

/**
 * Whether a value fits the type of a field.
 * @param {object} field
 * @param {unknown} value
 * @returns {boolean}
 * @ai.hint pure
 */
function fitsType(field, value) {
    const types = Array.isArray(field.type) ? field.type : [field.type];
    if (value === null) return types.includes('null');
    const actual = typeof value;
    if (actual === 'number') {
        if (!types.includes('integer') && !types.includes('number')) return false;
        if (types.includes('integer') && !Number.isInteger(value)) return false;
    } else if (actual === 'object') {
        if (!types.includes('array') || !Array.isArray(value)) return false;
    } else if (!types.includes(actual)) {
        return false;
    }
    if (Array.isArray(field.enum) && !field.enum.includes(value)) return false;
    return true;
}

/**
 * The catalog of the tools of the package.
 *
 * The names are the names of the model: a snake_case name that the model reads well and
 * that the extension may hold for itself.
 */
export const TOOL_SPECS = Object.freeze({
    list_files: {
        category: 'read',
        group: 'fs',
        risk: 'low',
        description: 'List the files and the directories of a path of the working directory. The noisy folders (node_modules, .git, dist) are skipped. A path that does not exist yet returns the nearest existing parent instead of an error.',
        parameters: schema({
            path: str('The path of the directory, relative to the working directory; "." for the root.'),
            depth: nullableInt('How many levels deep to list (1-6). The default is 2.'),
            include_hidden: bool('Include the dot-files and the dot-directories.'),
        }, ['depth', 'include_hidden']),
    },
    read_file: {
        category: 'read',
        group: 'fs',
        risk: 'low',
        description: 'Read a UTF-8 text file. The answer holds the numbered lines ("N| text"). Use start_line and end_line for a big file.',
        parameters: schema({
            path: str('The path of the file, relative to the working directory.'),
            start_line: nullableInt('The first line to return (1-based). Null = from the beginning.'),
            end_line: nullableInt('The last line to return (inclusive). Null = to the end, within the size limit.'),
        }, ['start_line', 'end_line']),
    },
    search_files: {
        category: 'read',
        group: 'fs',
        risk: 'low',
        description: 'Search the files for a string or for a regular expression. The answer holds the matches as "path:line: text". With inContent=false the paths of the files are matched instead of their text.',
        parameters: schema({
            query: str('The text to look for (case-insensitive), or a regular expression when regex is true.'),
            path: nullableStr('The directory to search in, relative to the working directory. Null = the whole root.'),
            regex: bool('Read the query as a regular expression.'),
            inContent: bool('Search the text of the files. False = match the paths of the files.'),
            glob: nullableStr('The names of the files to search in, like `*.scss`. Null = every file.'),
        }, ['path', 'regex', 'inContent', 'glob']),
    },
    write_file: {
        category: 'write',
        group: 'fs',
        risk: 'medium',
        description: 'Create a UTF-8 file or overwrite it. The missing parents are created. The old version is kept in the backup directory.',
        parameters: schema({
            path: str('The path of the file, relative to the working directory.'),
            content: str('The whole content of the file.'),
            overwrite: bool('Overwrite an existing file. The default is true.'),
        }, ['overwrite']),
    },
    replace_in_file: {
        category: 'write',
        group: 'fs',
        risk: 'medium',
        description: 'Replace a fragment of a file. The fragment must be unique, unless all is true.',
        parameters: schema({
            path: str('The path of the file, relative to the working directory.'),
            search: str('The text to replace.'),
            replacement: str('The text to put instead.'),
            all: bool('Replace every occurrence. The default is false.'),
        }, ['all']),
    },
    delete_file: {
        category: 'write',
        group: 'fs',
        risk: 'high',
        description: 'Delete a file. The old version is kept in the backup directory.',
        parameters: schema({
            path: str('The path of the file, relative to the working directory.'),
        }),
    },
    make_directory: {
        category: 'write',
        group: 'fs',
        risk: 'low',
        description: 'Create a directory and the missing parents.',
        parameters: schema({
            path: str('The path of the directory, relative to the working directory.'),
        }),
    },
    copy_path: {
        category: 'write',
        group: 'fs',
        risk: 'medium',
        description: 'Copy a file or a tree into another path of the working directory. The destination must not exist.',
        parameters: schema({
            source: str('The path of the source, relative to the working directory.'),
            destination: str('The path of the destination, relative to the working directory.'),
        }),
    },
    run_command: {
        category: 'exec',
        group: 'shell',
        risk: 'high',
        description: 'Run one command in the working directory and return the exit code with the captured stdout and stderr. The shell may be powershell, pwsh, cmd, bash, sh or zsh; an empty shell uses the platform default. The command is non-interactive, the output is capped, and the command must exit: do not use it for a dev server.',
        parameters: schema({
            command: str('The command line to execute.'),
            shell: { type: 'string', enum: [...SHELLS], description: 'The interpreter: powershell, pwsh, cmd, bash, sh, zsh. Empty = the platform default.' },
            cwd: nullableStr('The subdirectory to run in, relative to the working directory. Null = the working directory.'),
            timeout_seconds: nullableInt('The time limit in seconds (max 900). Null = the configured default.'),
        }, ['shell', 'cwd', 'timeout_seconds']),
    },
    run_script: {
        category: 'exec',
        group: 'shell',
        risk: 'high',
        description: 'Run a script file inside the working directory. A .ps1 file uses PowerShell, a .cmd or .bat file uses cmd, a .sh or .bash file uses bash. The shell may override the extension. The arguments are argv, not a shell string.',
        parameters: schema({
            path: str('The path of the script, relative to the working directory.'),
            args: { type: 'array', items: { type: 'string' }, description: 'The arguments of the script.' },
            shell: { type: 'string', enum: [...SHELLS], description: 'The interpreter that overrides the extension. Empty = the interpreter of the extension.' },
            cwd: nullableStr('The subdirectory to run in, relative to the working directory. Null = the working directory.'),
            timeout_seconds: nullableInt('The time limit in seconds (max 900). Null = the configured default.'),
        }, ['args', 'shell', 'cwd', 'timeout_seconds']),
    },
    scan_workspace: {
        category: 'read',
        group: 'workspace',
        risk: 'low',
        description: 'Read the workspace of the working directory: package.json, tsconfig or jsconfig, the import maps, and the root index.html. The answer names the kind of the project, the aliases of the imports, the entry points, and the files the task mentions.',
        parameters: schema({
            task: str('The task of the role. The files it mentions are the files to read or to edit.'),
        }, ['task']),
    },
    collect_context: {
        category: 'read',
        group: 'workspace',
        risk: 'low',
        description: 'Collect the context of a role: the card of the workspace, the AGENTS.md files of the project, and the files the task mentions as @path or @path#10-40.',
        parameters: schema({
            task: str('The task of the role.'),
            role: str('The name of the role. The default is agent.'),
        }, ['task', 'role']),
    },
    read_skill: {
        category: 'read',
        group: 'skills',
        risk: 'low',
        description: 'Read an installed Agent Skill by name. Use it before applying a design workflow, polish pass or visual review described by the skill.',
        parameters: schema({
            name: str('The name of the skill, for example `oil-ui`.'),
        }),
    },
    code_mode: {
        category: 'write',
        group: 'code_mode',
        risk: 'medium',
        description: 'Write a JavaScript program and run it in a sandbox, instead of calling the tools one by '
            + 'one. The program runs in its own worker with its own realm: it has no process, no require and '
            + 'no network, and it cannot touch the disk by itself — but it may call your tools, and every '
            + 'call travels back to the server, which runs it with your rights, your rules and your '
            + 'approval. Use it when the work is a sequence of many calls: reading five files and merging '
            + 'them is one program, not six round trips. The program may await, and it may return the answer '
            + 'of the step. Inside it: `await tools.<name>(args)` calls a tool; `catalogue.names` lists the '
            + 'tools you may call; `fs` is a file system in the memory; `shared` is the shared block of the '
            + 'run; `allocate(bytes)` gives a block of memory; `console.log` writes to the output of the run. '
            + 'The program is sandboxed: a loop that never ends is stopped, and a mistake is an error, not a '
            + 'crash of the server. This tool writes: it needs the approval of a write, and it earns the '
            + 'budget of the write.',
        parameters: schema({
            code: str('The program. The body of an async function: it may await, and it may return the '
                + 'answer of the step. The tools are called as `await tools.name({ ... })`.'),
            purpose: str('One sentence: what the program has to do. It is written into the report of the run.'),
            timeoutMs: nullableInt('How long the program may run, in milliseconds. Null = 60000.'),
        }, ['purpose', 'timeoutMs']),
    },
    subagent: {
        category: 'read',
        group: 'subagent',
        risk: 'low',
        description: 'Hand one bounded task to a sub-agent: a separate worker (a thread or a process of the '
            + 'server) that inherits the role of analyzer, director or executor. The sub-agent starts with '
            + 'a clean conversation, its own instructions, its own tools and its own budget of turns — and '
            + 'it does not see this one. It inherits your tools and your rights: it works in the same '
            + 'project, and the files it writes are written by your tools — through the same hub, with the '
            + 'same approval, so a client that holds a tool runs it for the sub-agent too. By default it '
            + 'answers with the model of the run over the API of the run; name `model`, `effort` or '
            + '`apiKey` to run it on another one. Use it when the work is one specific bounded piece: a '
            + 'wide search, a scan, a second opinion. Name every expected output path in `files`, and '
            + 'verify that those files appeared on disk.',
        parameters: schema({
            role: str('The role the sub-agent inherits: analyzer | director | executor.'),
            task: str('What that role has to do, in full: the file, what is wrong and what the result '
                + 'has to be. The sub-agent does not see this conversation.'),
            reason: str('One sentence: why the work goes to that role.'),
            files: {
                type: 'array',
                description: 'Expected output file paths, relative to the working directory. Include every file the sub-agent must write.',
                items: str('Path of an expected output file.'),
            },
            model: str('The model of the sub-agent, when it is not the model of the run: '
                + 'an id like openai/gpt-6.1-terra. Empty = the model of the run.'),
            effort: str('The effort of the reasoning of the sub-agent: minimal | low | medium | high | xhigh. '
                + 'Empty = the effort of the run.'),
            apiKey: str('The key of the API of the sub-agent, when it is not the key of the run. '
                + 'Empty = the key of the run.'),
            transport: str('Where the sub-agent runs: thread (a worker thread of this process, '
                + 'the default) or process (a child process of its own, with its own crash domain).'),
        }, ['reason', 'model', 'effort', 'apiKey', 'transport']),
    },
    suggest: {
        category: 'read',
        group: 'suggest',
        risk: 'low',
        description: 'Suggest the paths and the commands that fit the context: the paths of the tree that carry the prefix, and the scripts of package.json.',
        parameters: schema({
            prefix: str('The text the paths carry. Empty = the first paths of the tree.'),
            kind: { type: 'string', enum: ['path', 'command', 'all'], description: 'What to suggest. The default is all.' },
        }, ['prefix', 'kind']),
    },
    screenshot: {
        category: 'read',
        group: 'browser',
        risk: 'low',
        description: 'Open the page of the working directory in a real browser (Ego Lite when it is installed, otherwise headless Chrome/Edge) and take a screenshot of it. The project is served locally, so no server has to be running. Use it to see the result of the work: a layout that compiles may still be broken. The answer names the file of the picture and what the page says about itself: the console, the exceptions and the failed requests.',
        parameters: schema({
            path: nullableStr('The page to shoot, relative to the working directory (for example `index.html`). Null = the entry point of the project.'),
            output: nullableStr('Where to write the picture, relative to the working directory. Null = .ai/shots/page-<time>.png.'),
            url: nullableStr('A live address of the page, for example the dev server of the project (http://localhost:5173/). Null = the page of the working directory.'),
            width: nullableInt('The width of the picture in pixels. The default is 1440.'),
            height: nullableInt('The height of the picture in pixels. The default is 900.'),
        }, ['path', 'output', 'url', 'width', 'height']),
    },
});

/** The names of the tools of the package. */
export const TOOL_NAMES = Object.freeze(Object.keys(TOOL_SPECS));

/**
 * The names of the monolith of the version 0.2 and the names of the catalog.
 *
 * The extension of the old version holds `replace_text`; the tool of the package is
 * `replace_in_file`. The bus speaks the old names, the catalog keeps its own.
 */
export const TOOL_ALIASES = Object.freeze({ replace_text: 'replace_in_file' });

/**
 * The name of a tool of the catalog: the old name goes to the new one.
 * @param {string} name
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function resolveToolName(name) {
    const key = String(name ?? '').trim();
    return TOOL_ALIASES[key] ?? key;
}

/**
 * Whether the tool needs the permission of the user.
 *
 * The mode of the run decides: `ask` asks for every category, `read` lets the reading
 * tools go, `write` lets the reading and the writing tools go, and `all` lets everything
 * go. A tool that does not exist always needs the permission: it is refused anyway.
 *
 * @param {string} name
 * @param {string} [mode] one of `ask`, `read`, `write`, `all`
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function needsApproval(name, mode = 'ask') {
    const spec = TOOL_SPECS[resolveToolName(name)];
    if (!spec) return true;
    const level = { read: 0, write: 1, exec: 2 }[spec.category] ?? 2;
    const free = { ask: -1, read: 0, write: 1, all: 2 }[mode] ?? -1;
    return level > free;
}

/**
 * One line about what the tool did.
 * @param {string} name
 * @param {object|null} data the answer of the tool
 * @param {object} [args] the arguments of the tool
 * @returns {string}
 * @ai.hint pure
 */
function toolSummary(name, data, args = {}) {
    const rel = typeof data?.rel === 'string' ? data.rel : (typeof args.path === 'string' ? args.path : null);
    switch (name) {
        case 'read_file': return rel ? `read ${rel}` : 'read the file';
        case 'list_files': return rel ? `listed ${rel}` : 'listed the files';
        case 'search_files': return `searched for ${args.query ?? ''}`.trim();
        case 'write_file': return rel ? `${data?.created ? 'created' : 'wrote'} ${rel}` : 'wrote the file';
        case 'replace_in_file': return rel ? `edited ${rel}` : 'edited the file';
        case 'delete_file': return rel ? `deleted ${rel}` : 'deleted the file';
        case 'make_directory': return rel ? `created the directory ${rel}` : 'created the directory';
        case 'copy_path': return `copied ${data?.source ?? ''} to ${data?.destination ?? ''}`.trim();
        case 'run_command': return `ran ${data?.command ?? 'the command'}`;
        case 'run_script': return `ran ${data?.path ?? 'the script'}`;
        case 'read_skill': return `read the skill ${args.name ?? ''}`.trim();
        case 'subagent': return `handed work to the sub-agent ${args.role ?? ''}`.trim();
        default: return `ran ${name}`;
    }
}

/**
 * The files that the tool touched.
 * @param {string} name
 * @param {object|null} data the answer of the tool
 * @returns {Array<{ op: string, path: string }>}
 * @ai.hint pure
 */
function toolChanges(name, data) {
    const rel = typeof data?.rel === 'string' ? data.rel : null;
    switch (name) {
        case 'write_file':
            return rel ? [{ op: data?.created ? 'create' : 'overwrite', path: rel }] : [];
        case 'replace_in_file':
            return rel ? [{ op: 'edit', path: rel }] : [];
        case 'delete_file':
            return rel ? [{ op: 'delete', path: rel }] : [];
        case 'make_directory':
            return rel ? [{ op: 'create', path: rel }] : [];
        case 'copy_path':
            return typeof data?.destination === 'string' ? [{ op: 'create', path: data.destination }] : [];
        default:
            return [];
    }
}

/**
 * Run a tool of the catalog as a request of the bus.
 *
 * The answer has the shape of the `tool.result` frame: the text of the tool, one line
 * about it and the files it touched. A failure is an answer too: the bus needs a result,
 * not an exception.
 *
 * @param {string} name
 * @param {object} [args]
 * @param {{ root: string, config?: object|null, signal?: AbortSignal|null, approve?: string,
 *           approveFn?: Function|null }} [context]
 * @returns {Promise<{ ok: boolean, output: string, summary: string,
 *           changes: Array<{ op: string, path: string }>, error: string|null, approval?: string }>}
 * @exports
 * @ai.hint io
 */
export async function executeToolRequest(name, args = {}, {
    root,
    config = null,
    signal = null,
    approve = 'ask',
    approveFn = null,
} = {}) {
    const tool = resolveToolName(name);
    const fail = (error, approval = null) => ({
        ok: false,
        output: '',
        summary: '',
        changes: [],
        error,
        ...(approval ? { approval } : {}),
    });
    if (!TOOL_SPECS[tool]) return fail(`There is no tool named ${name}.`);
    if (!toolAllowed(tool, config)) return fail(`The configuration does not allow the tool ${tool}.`);
    if (!root) return fail('The root of the tools is not set.');

    if (needsApproval(tool, approve)) {
        const category = TOOL_SPECS[tool].category;
        const allowed = typeof approveFn === 'function'
            ? await approveFn({ name: tool, category, args })
            : false;
        if (!allowed) return fail(`The tool ${tool} was not allowed.`, 'required');
    }

    try {
        const out = await executeTool(tool, args, { root, config, signal });
        return {
            ok: true,
            output: typeof out?.text === 'string' ? out.text : '',
            summary: toolSummary(tool, out?.data ?? null, args ?? {}),
            changes: toolChanges(tool, out?.data ?? null),
            error: null,
        };
    } catch (error) {
        return fail(error?.message ?? String(error));
    }
}

/**
 * The catalog as the tools of a request: the shape the Responses API expects.
 * @param {string[]} [names] the tools to take; the whole catalog by default
 * @returns {Array<{ type: 'function', name: string, description: string, parameters: object }>}
 * @exports
 * @ai.hint pure
 */
export function toolDefinitions(names = TOOL_NAMES) {
    const wanted = Array.isArray(names) && names.length ? names : TOOL_NAMES;
    const out = [];
    for (const name of wanted) {
        const spec = TOOL_SPECS[name];
        if (!spec) continue;
        out.push({
            type: 'function',
            name,
            description: spec.description,
            parameters: spec.parameters,
        });
    }
    return out;
}

/**
 * The catalog as a short list: the name, the category and the risk.
 * @returns {Array<{ name: string, category: string, group: string, risk: string, description: string }>}
 * @exports
 * @ai.hint pure
 */
export function describeTool(name) {
    const spec = TOOL_SPECS[name];
    if (!spec) return null;
    return {
        name,
        category: spec.category,
        group: spec.group,
        risk: spec.risk,
        description: spec.description,
    };
}

/**
 * The category of a tool.
 * @param {string} name
 * @returns {string|null}
 * @exports
 * @ai.hint pure
 */
export function toolCategory(name) {
    return TOOL_SPECS[name]?.category ?? null;
}

/**
 * The risk of a tool.
 * @param {string} name
 * @returns {string|null}
 * @exports
 * @ai.hint pure
 */
export function toolRisk(name) {
    return TOOL_SPECS[name]?.risk ?? null;
}

/**
 * The names of the tools of a category.
 * @param {string} category
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function toolsByCategory(category) {
    return TOOL_NAMES.filter((name) => TOOL_SPECS[name].category === category);
}

/**
 * The flags of the configuration that carry the group of a tool.
 *
 * The group `fs` is covered by the flags of the categories it holds: `read` for the
 * reading tools and `write` for the changing ones.
 */
const GROUP_FLAGS = Object.freeze({
    fs: 'read',
    shell: 'terminal',
    workspace: 'workspace',
    suggest: 'suggest',
    skills: 'skills',
    subagent: 'subagent',
    browser: 'browser',
    code_mode: 'code_mode',
});

/**
 * Whether the configuration allows the tool.
 *
 * The flags of the configuration decide it: `tools.read`, `tools.write`,
 * `tools.allowWrite`, `tools.allowTerminal` and the flags of the groups. A tool that is
 * not allowed is not published and not called.
 *
 * @param {string} name
 * @param {object|null} [config]
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function toolAllowed(name, config = null) {
    const spec = TOOL_SPECS[name];
    if (!spec) return false;
    const flags = config?.tools ?? {};
    const groupFlag = GROUP_FLAGS[spec.group];
    if (groupFlag && flags[groupFlag] === false) return false;
    if (spec.category === 'read' && flags.read === false) return false;
    if (spec.category === 'write' && (flags.write === false || flags.allowWrite === false)) return false;
    if (spec.category === 'exec' && (flags.terminal === false || flags.allowTerminal === false)) return false;
    return true;
}

/**
 * The answer of a command: the exit code, the output, and the flags of the run.
 * @param {object} out
 * @returns {string}
 * @ai.hint pure
 */
function commandText(out) {
    return [
        `exit: ${out.exitCode ?? 'null'}${out.timedOut ? ' (the time is up)' : ''}${out.cancelled ? ' (cancelled)' : ''}`,
        out.stdout ? `stdout:\n${out.stdout}` : '',
        out.stderr ? `stderr:\n${out.stderr}` : '',
        out.truncated ? 'the output is cut.' : '',
    ].filter((part) => part).join('\n');
}

/**
 * Run a script file of the root and answer with the exit code and the output.
 *
 * The path of the script goes through `agent/access`, so the script is always inside the
 * root of the run.
 * @param {{ root: string, path: string, args?: string[], shell?: string|null, cwd?: string|null,
 *           timeoutMs?: number, maxOutputBytes?: number, signal?: AbortSignal }} options
 * @returns {Promise<{ text: string, data: object }>}
 * @ai.hint io
 */
async function runScript({ root, path: file, args = [], shell = null, cwd = null, timeoutMs, maxOutputBytes, signal }) {
    const inside = await resolveInside(root, file, { allowRoot: false });
    const launch = scriptLaunch(inside.abs, { shell, args });
    const out = await runProgram({
        ...launch,
        cwd: cwd ?? null,
        root,
        timeoutMs,
        maxOutputBytes,
        signal,
    });
    return { text: commandText(out), data: { ...out, path: inside.rel } };
}

/**
 * Run a tool of the catalog by its name.
 *
 * The arguments come from the model, so they are checked against the schema of the tool
 * before anything touches the disk: an unknown name, a missing argument, or an argument
 * of the wrong type is a refusal, not a half-done change.
 * @param {string} name
 * @param {object} args
 * @param {{ root: string, config?: object|null, signal?: AbortSignal }} context
 * @returns {Promise<{ text: string, data?: object }>}
 * @exports
 * @ai.hint io
 */
export async function executeTool(name, args = {}, { root, config = null, signal } = {}) {
    const spec = TOOL_SPECS[name];
    if (!spec) throw new Error(`There is no tool named ${name}.`);
    if (!root) throw new Error('The root of the tools is not set.');
    const params = args ?? {};
    const properties = spec.parameters.properties;
    const required = new Set(spec.parameters.required ?? []);
    for (const key of Object.keys(params)) {
        if (!(key in properties)) throw new Error(`The tool ${name} has no argument ${key}.`);
    }
    for (const [key, schemaOf] of Object.entries(properties)) {
        const value = params[key];
        if (value === undefined || value === null) {
            if (required.has(key)) throw new Error(`The tool ${name} needs the argument ${key}.`);
            continue;
        }
        if (!fitsType(schemaOf, value)) {
            const types = Array.isArray(schemaOf.type) ? schemaOf.type.join(' or ') : schemaOf.type;
            throw new Error(`The argument ${key} of the tool ${name} must be ${types}.`);
        }
    }

    const limits = config?.limits ?? {};
    const backupDir = config?.backupDir ?? null;
    const result = await {
        list_files: () => listFiles({
            root,
            dir: params.path ?? '.',
            depth: params.depth ?? 2,
            includeHidden: params.include_hidden ?? false,
        }),
        read_file: () => readTextFile({
            root,
            file: params.path,
            startLine: params.start_line ?? null,
            endLine: params.end_line ?? null,
            maxBytes: limits.maxFileReadBytes ?? 256 * 1024,
        }),
        search_files: () => searchFiles({
            root,
            query: params.query,
            dir: params.path ?? '.',
            regex: params.regex ?? false,
            inContent: params.inContent !== false,
            glob: params.glob ?? '',
        }),
        write_file: () => writeTextFile({
            root,
            file: params.path,
            content: params.content,
            overwrite: params.overwrite ?? true,
            maxBytes: limits.maxWriteBytes ?? 4 * 1024 * 1024,
            backupDir,
        }),
        replace_in_file: () => replaceInFile({
            root,
            file: params.path,
            search: params.search,
            replacement: params.replacement,
            all: params.all ?? false,
            maxBytes: limits.maxWriteBytes ?? 4 * 1024 * 1024,
            backupDir,
        }),
        delete_file: () => deleteFile({ root, file: params.path, backupDir }),
        make_directory: () => makeDirectory({ root, dir: params.path }),
        copy_path: () => copyPath({ root, source: params.source, destination: params.destination }),
        run_command: () => runCommand({
            command: params.command,
            shell: params.shell || null,
            cwd: params.cwd ?? null,
            root,
            timeoutMs: params.timeout_seconds ? params.timeout_seconds * 1000 : (limits.commandTimeoutMs ?? 180_000),
            maxOutputBytes: limits.maxOutputBytes ?? 64 * 1024,
            signal,
        }).then((out) => ({ text: commandText(out), data: out })),
        run_script: () => runScript({
            root,
            path: params.path,
            args: params.args ?? [],
            shell: params.shell || null,
            cwd: params.cwd ?? null,
            timeoutMs: params.timeout_seconds ? params.timeout_seconds * 1000 : (limits.commandTimeoutMs ?? 180_000),
            maxOutputBytes: limits.maxOutputBytes ?? 64 * 1024,
            signal,
        }),
        scan_workspace: async () => {
            const card = await scanWorkspace(root, { task: params.task ?? '' });
            return { text: formatWorkspace(card), data: card };
        },
        collect_context: async () => {
            const context = await collectRoleContext({
                root,
                task: params.task ?? '',
                role: params.role ?? 'agent',
                home: config?.home ?? null,
            });
            return { text: context.text, data: context };
        },
        read_skill: async () => {
            const extraDirs = skillsDirectory(config) ? [skillsDirectory(config)] : [];
            const skill = await readSkill(params.name, root, { extraDirs });
            if (!skill) throw new Error(`There is no skill named ${params.name}.`);
            const head = skill.description ? `${skill.description}\n\n` : '';
            return {
                text: `# ${skill.name}\n\n${head}${skill.body}`,
                data: { name: skill.name, description: skill.description, path: skill.path },
            };
        },
        // The hand-over to a sub-agent is not run here: the tool is wired in the agent of
        // the run, where the executor, the API data and the events of the run live. A call
        // that reaches this runner says so instead of doing nothing.
        subagent: async () => {
            throw new Error('The tool `subagent` is wired in the agent of the run, not in the catalog.');
        },
        // Code Mode: the program of the model runs in the sandbox, and every tool it
        // calls travels back here: the server runs it with the rules of the server.
        code_mode: async () => {
            // The program also gets the **access** of the run as a facility: the files and
            // the commands of the project, with the rules of the access. What it writes
            // goes through the same gate as `write_file` — the same backup, the same
            // limits — so a program cannot write where the server may not.
            const access = accessFacilities({
                root,
                config,
                env: process.env,
                timeoutMs: 120_000,
                write: async (rel, content) => {
                    const out = await writeTextFile({
                        root,
                        file: rel,
                        content,
                        overwrite: true,
                        maxBytes: limits.maxWriteBytes ?? 4 * 1024 * 1024,
                        backupDir,
                    });
                    return { path: out?.rel ?? rel, bytes: out?.bytes ?? Buffer.byteLength(content, 'utf8') };
                },
            });
            const runner = createCodeModeRunner({
                execute: async (toolName, toolArgs) => {
                    const out = await executeTool(toolName, toolArgs, { root, config, signal });
                    return typeof out?.text === 'string' ? out.text : JSON.stringify(out ?? null);
                },
                specs: toolDefinitions(),
                signal,
                facilities: access,
                facilityDescriptions: accessFacilityDescriptions(),
            });
            const answer = await runner(params);
            return { text: answer, data: { code: params.code ?? '' } };
        },
        suggest: async () => {
            const out = await suggest({
                root,
                prefix: params.prefix ?? '',
                kind: params.kind ?? 'all',
            });
            const lines = [
                ...out.paths.map((item) => `- ${item}`),
                ...out.commands.map((item) => `- ${item}`),
            ];
            return { text: lines.join('\n') || '- (none)', data: out };
        },
        screenshot: async () => {
            const shot = await screenshotPage({
                root,
                config: config ?? {},
                page: params.path ?? null,
                output: params.output ?? '',
                url: params.url ?? null,
                width: params.width ?? 1440,
                height: params.height ?? 900,
            });
            const lines = [
                `The screenshot of the page is ready: ${shot.rel}`,
                `bytes: ${shot.bytes}`,
                `engine: ${shot.engine}`,
            ];
            if (shot.log) {
                lines.push('', 'What the page says about itself:', shot.log);
            }
            return { text: lines.join('\n'), data: shot };
        },
    }[name]();

    if (result && typeof result.text === 'string') return { text: result.text, data: result };
    return { text: JSON.stringify(result ?? null), data: result };
}
