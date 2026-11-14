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
 * @depends agent/access, tools/filesystem, shared/format
 * @usedBy agent/roles, server/mcp, server/http
 * @exports TOOL_SPECS, TOOL_NAMES, TOOL_CATEGORIES, TOOL_RISKS, toolDefinitions,
 *          describeTool, toolCategory, toolRisk, toolsByCategory, executeTool
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
    if (actual === 'number') return types.includes('integer') || types.includes('number');
    return types.includes(actual);
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
        description: 'Search the text files for a string or for a regular expression. The answer holds the matches as "path:line: text".',
        parameters: schema({
            query: str('The text to look for (case-insensitive), or a regular expression when regex is true.'),
            path: nullableStr('The directory to search in, relative to the working directory. Null = the whole root.'),
            regex: bool('Read the query as a regular expression.'),
        }, ['path', 'regex']),
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
});

/** The names of the tools of the package. */
export const TOOL_NAMES = Object.freeze(Object.keys(TOOL_SPECS));

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
 * Run a tool of the catalog by its name.
 *
 * The arguments come from the model, so they are checked against the schema of the tool
 * before anything touches the disk: an unknown name, a missing argument, or an argument
 * of the wrong type is a refusal, not a half-done change.
 * @param {string} name
 * @param {object} args
 * @param {{ root: string, config?: object|null }} context
 * @returns {Promise<{ text: string, data?: object }>}
 * @exports
 * @ai.hint io
 */
export async function executeTool(name, args = {}, { root, config = null } = {}) {
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
    }[name]();

    if (result && typeof result.text === 'string') return { text: result.text, data: result };
    return { text: JSON.stringify(result ?? null), data: result };
}
