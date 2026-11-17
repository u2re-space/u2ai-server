/**
 * @file src/openai/responses.js
 * @module openai/responses
 * @purpose Build Responses API request bodies, parse their answers, and reduce the events of
 *          a streamed answer.
 * @depends openai/http
 * @usedBy openai/client, roles/index, agent/autocomplete
 * @exports buildResponsesBody, parseResponse, extractToolCalls, imagePart, textPart, functionTool,
 *          parseJsonText, createStreamReducer, outputText, refusalText, normalizeUsage
 * @ai.tags responses
 * @ai.hint pure
 */

import { ApiError } from './http.js';
import { assetPart, scrubDataUrls, scrubItems } from '../shared/data-urls.js';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const textOf = (value) => (typeof value === 'string' ? value : '');

/**
 * A text input part.
 * @param {string} text
 * @returns {object}
 * @ai.hint pure
 */
export function textPart(text) {
    return { type: 'input_text', text: String(text ?? '') };
}

/**
 * An image input part from raw bytes: the API takes a data URL, not a file.
 * @param {Buffer|Uint8Array} bytes
 * @param {string} mime image mime type
 * @returns {object}
 * @ai.hint pure
 */
export function imagePart(bytes, mime = 'image/png') {
    const data = Buffer.isBuffer(bytes) ? bytes.toString('base64') : Buffer.from(bytes).toString('base64');
    return { type: 'input_image', image_url: `data:${mime};base64,${data}` };
}

/**
 * A function tool definition in the Responses shape.
 * @param {string} name
 * @param {string} description
 * @param {object} parameters JSON schema of the arguments
 * @returns {object}
 * @ai.hint pure
 */
export function functionTool(name, description, parameters) {
    return {
        type: 'function',
        name,
        description,
        parameters: isRecord(parameters) ? parameters : { type: 'object', properties: {} },
    };
}

/**
 * Build the body of a Responses API request.
 *
 * The builder is the only place that knows the wire names, so the roles speak in domain terms
 * (instructions, a text prompt, attached images, a JSON schema) and the transport stays
 * replaceable.
 * @param {object} params
 * @param {string} params.model model id
 * @param {string|null} [params.instructions] system instructions of the role
 * @param {string|object[]|null} [params.input] user text or ready input items
 * @param {object[]} [params.parts] extra input parts (images) for the user message
 * @param {object[]} [params.tools] function tools
 * @param {object|null} [params.schema] JSON schema the answer must follow
 * @param {string} [params.schemaName] name of the schema tool
 * @param {'auto'|'tool'|'format'} [params.schemaChannel] where the schema is put:
 *   `tool` makes it a function the model calls, `format` makes it a `text.format`
 *   rule, `auto` picks `tool` when the role has other tools and `format` otherwise.
 * @param {string|null} [params.effort] reasoning effort
 * @param {string|null} [params.summary] reasoning summary mode
 * @param {string|null} [params.mode] gateway reasoning mode
 * @param {number|null} [params.maxOutputTokens]
 * @param {number|null} [params.temperature]
 * @param {boolean} [params.store] send `store: true`
 * @param {string|null} [params.truncation]
 * @param {boolean} [params.stream]
 * @param {string|null} [params.previousResponseId]
 * @returns {object} the request body
 */
export function buildResponsesBody({
    model,
    instructions = null,
    input = null,
    parts = null,
    tools = null,
    schema = null,
    schemaName = 'response',
    schemaChannel = 'auto',
    strict = true,
    effort = null,
    summary = null,
    mode = null,
    maxOutputTokens = null,
    temperature = null,
    store = false,
    truncation = null,
    verbosity = null,
    stream = false,
    previousResponseId = null,
    toolChoice = null,
    parallelToolCalls = null,
} = {}) {
    const body = { model };
    // The instructions are text: a data URL in them is cut out and replaced with a note.
    const clean = scrubDataUrls(textOf(instructions));
    if (clean.text.trim()) body.instructions = clean.text;
    if (previousResponseId) body.previous_response_id = previousResponseId;

    // Input: a ready item list is passed through, text and parts are packed into one user message.
    //
    // The data URLs are cut out of the text of the conversation and put into the request as
    // what they are: a picture goes as a picture, a file goes as a file. The model sees the
    // same thing, and the text does not carry a wall of base64.
    if (Array.isArray(input)) {
        const scrubbed = scrubItems(input);
        body.input = scrubbed.items;
        const assets = scrubbed.assets.map((asset) => assetPart(asset)).filter(Boolean);
        if (assets.length) {
            body.input = [
                ...body.input,
                {
                    role: 'user',
                    content: [
                        textPart('The data of the messages above is attached here: the picture and the files travel as themselves, not as text.'),
                        ...assets,
                    ],
                },
            ];
        }
    } else {
        const content = [];
        const scrubbed = scrubDataUrls(textOf(input));
        if (scrubbed.text.trim()) content.push(textPart(scrubbed.text));
        for (const part of scrubbed.assets.map((asset) => assetPart(asset)).filter(Boolean)) {
            content.push(part);
        }
        for (const part of Array.isArray(parts) ? parts : []) {
            if (!part) continue;
            content.push(part);
        }
        body.input = content.length
            ? [{ role: 'user', content }]
            : [{ role: 'user', content: [{ type: 'input_text', text: '' }] }];
    }

    const toolList = Array.isArray(tools) ? tools.filter((tool) => isRecord(tool)) : [];
    const hasSchema = isRecord(schema);

    // Where the schema travels. A role that has tools needs the schema to be a tool as well:
    // with a `text.format` rule in place the model answers straight away with the skeleton of
    // the schema instead of looking at the picture, and the tools are never called.
    const channel = !hasSchema
        ? 'none'
        : (schemaChannel === 'auto' ? (toolList.length ? 'tool' : 'format') : schemaChannel);

    if (hasSchema && channel === 'tool') {
        toolList.push({
            type: 'function',
            name: schemaName,
            description: `Submit the final ${schemaName}. Call this tool exactly once, with the complete answer; do not answer in prose.`,
            parameters: schema,
            strict,
        });
    }
    if (toolList.length) body.tools = toolList;
    if (toolChoice) body.tool_choice = toolChoice;
    if (parallelToolCalls === true) body.parallel_tool_calls = true;

    if (hasSchema && channel === 'format') {
        body.text = { format: { type: 'json_schema', name: schemaName, schema, strict } };
    }

    const reasoning = {};
    if (effort) reasoning.effort = effort;
    if (summary) reasoning.summary = summary;
    if (mode && mode !== 'off') reasoning.mode = mode;
    if (Object.keys(reasoning).length) body.reasoning = reasoning;

    if (Number.isSafeInteger(maxOutputTokens) && maxOutputTokens > 0) body.max_output_tokens = maxOutputTokens;
    if (typeof temperature === 'number') body.temperature = temperature;
    if (typeof verbosity === 'string') body.text = { ...(body.text ?? {}), verbosity };
    if (store) body.store = true;
    if (textOf(truncation)) body.truncation = truncation;
    if (stream) body.stream = true;
    return body;
}

/**
 * Tool calls of a response, in the shape the role code reads.
 * @param {object} raw a Responses API answer
 * @returns {Array<{ id: string|null, name: string, arguments: object, raw: string }>}
 */
export function extractToolCalls(raw) {
    const out = [];
    for (const item of Array.isArray(raw?.output) ? raw.output : []) {
        if (item?.type !== 'function_call') continue;
        const rawArgs = textOf(item.arguments) || '{}';
        let args = {};
        try { args = JSON.parse(rawArgs); } catch { args = {}; }
        out.push({ id: item.id ?? null, callId: item.call_id ?? null, name: textOf(item.name), arguments: args, raw: rawArgs });
    }
    return out;
}

/**
 * Parse a JSON answer that may be dressed up.
 *
 * A gateway may wrap the answer in a code fence, and a model may add a line of prose before
 * it. The object is still in there: the first `{` and the last `}` frame it.
 * @param {string} text
 * @returns {object|null}
 * @exports
 * @ai.hint pure
 */
export function parseJsonText(text) {
    const source = textOf(text).trim();
    if (!source) return null;
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(source);
    const body = fenced ? fenced[1].trim() : source;
    try {
        const parsed = JSON.parse(body);
        return isRecord(parsed) || Array.isArray(parsed) ? parsed : null;
    } catch {
        // Not the whole text: look for the object inside it.
    }
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
        const parsed = JSON.parse(body.slice(start, end + 1));
        return isRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Parse a Responses API answer into a stable shape.
 *
 * `text` is the whole answer, `data` is the answer parsed as JSON (null when it is not JSON),
 * `toolCalls` are the function calls the model asked for.
 *
 * When the schema travels as a tool, the answer is the call of that tool: the model returns the
 * object as the arguments of the call, and there is no text to read. `schemaName` names that
 * tool; without it the text of the message is the only source.
 * @param {object} raw
 * @param {{ schemaName?: string|null }} [options]
 * @returns {{ id: string|null, status: string, model: string|null, text: string, data: object|null, toolCalls: object[], usage: object|null, refusal: string, error: object|null, schemaAnswer: boolean, raw: object }}
 */
export function parseResponse(raw, { schemaName = null } = {}) {
    const toolCalls = extractToolCalls(raw);
    const schemaCall = schemaName
        ? toolCalls.find((call) => call.name === schemaName) ?? null
        : null;
    const messageText = textOf(raw?.output_text) || outputText(raw);

    let text = messageText;
    let data = null;
    if (schemaCall) {
        text = schemaCall.raw;
        data = schemaCall.arguments;
        if (!isRecord(data) || !Object.keys(data).length) {
            // The arguments did not parse: the answer is not there.
            try { data = JSON.parse(schemaCall.raw); } catch { data = null; }
        }
    } else {
        data = parseJsonText(messageText);
    }

    return {
        id: raw?.id ?? null,
        status: raw?.status ?? 'completed',
        model: raw?.model ?? null,
        text,
        data,
        toolCalls,
        usage: normalizeUsage(raw?.usage),
        refusal: refusalText(raw),
        error: raw?.error ?? null,
        schemaAnswer: Boolean(schemaCall),
        raw,
    };
}

/** Built-in tool kinds the reducer reports as progress. */
const BUILTIN_KINDS = {
    image_generation_call: 'image_generation',
    web_search_call: 'web_search',
    file_search_call: 'file_search',
    code_interpreter_call: 'code_interpreter',
    computer_call: 'computer',
    mcp_call: 'mcp',
    mcp_list_tools: 'mcp',
    local_shell_call: 'local_shell',
    custom_tool_call: 'custom_tool',
};

/**
 * Turns raw Responses API streaming events into a small, stable set of application events
 * and keeps track of the final response object. Also accumulates streamed text so that a
 * truncated stream still yields something useful.
 *
 * Application events (all have `type`):
 *   response.created {responseId, status, model}        response.status {status}
 *   text.delta {text, itemId}                           text.done {text, itemId}
 *   refusal.delta {text}                                reasoning.delta {text}   reasoning.done {text}
 *   tool.call.start {itemId, name, callId}              tool.args.delta {itemId, bytes}
 *   tool.args.done {itemId, name, arguments}
 *   builtin.start {kind, itemId}  builtin.progress {kind, itemId, status}  builtin.done {kind, item}
 *   item.done {item}                                    stream.error {code, message}
 * @param {{ emit?: Function }} [options]
 * @returns {object}
 */
export function createStreamReducer({ emit = () => {} } = {}) {
    let response = null;
    let lastSequence = null;
    let streamError = null;
    const items = new Map();            // output_index -> item (as added)
    const textByItem = new Map();       // item_id -> accumulated text
    const argsByItem = new Map();       // item_id -> accumulated arguments

    const notify = (event) => { try { emit(event); } catch { /* observers never break a request */ } };
    const kindOf = (item) => BUILTIN_KINDS[item?.type] ?? null;

    /**
     * Apply one raw stream event and emit the matching application event.
     * @param {object} event
     * @returns {void}
     * @ai.hint pure
     */
    function handle(event) {
        if (Number.isSafeInteger(event.sequence_number)) lastSequence = event.sequence_number;
        switch (event.type) {
            case 'response.created':
                response = event.response ?? response;
                notify({
                    type: 'response.created', responseId: response?.id ?? null,
                    status: response?.status ?? 'in_progress', model: response?.model ?? null,
                });
                break;
            case 'response.queued':
            case 'response.in_progress':
                response = event.response ?? response;
                notify({ type: 'response.status', status: event.type.slice('response.'.length), responseId: response?.id ?? null });
                break;
            case 'response.output_item.added': {
                const item = event.item ?? {};
                items.set(event.output_index, item);
                if (item.type === 'function_call') {
                    notify({ type: 'tool.call.start', itemId: item.id ?? null, name: item.name ?? null, callId: item.call_id ?? null });
                } else if (item.type === 'reasoning') {
                    notify({ type: 'reasoning.start', itemId: item.id ?? null });
                } else if (item.type === 'message') {
                    notify({ type: 'message.start', itemId: item.id ?? null, role: item.role ?? 'assistant' });
                } else if (kindOf(item)) {
                    notify({ type: 'builtin.start', kind: kindOf(item), itemId: item.id ?? null, item });
                }
                break;
            }
            case 'response.output_text.delta': {
                if (typeof event.delta !== 'string') throw new ApiError('The text delta is not a string.', { code: 'INVALID_SSE' });
                const id = event.item_id ?? `#${event.output_index}`;
                textByItem.set(id, (textByItem.get(id) ?? '') + event.delta);
                notify({ type: 'text.delta', text: event.delta, itemId: id });
                break;
            }
            case 'response.output_text.done':
                notify({ type: 'text.done', text: event.text ?? textByItem.get(event.item_id) ?? '', itemId: event.item_id ?? null });
                break;
            case 'response.refusal.delta':
                notify({ type: 'refusal.delta', text: String(event.delta ?? '') });
                break;
            case 'response.refusal.done':
                notify({ type: 'refusal.done', text: String(event.refusal ?? '') });
                break;
            case 'response.reasoning_summary_text.delta':
            case 'response.reasoning_text.delta':
                notify({ type: 'reasoning.delta', text: String(event.delta ?? ''), itemId: event.item_id ?? null });
                break;
            case 'response.reasoning_summary_text.done':
            case 'response.reasoning_text.done':
                notify({ type: 'reasoning.done', text: String(event.text ?? ''), itemId: event.item_id ?? null });
                break;
            case 'response.function_call_arguments.delta': {
                const id = event.item_id ?? `#${event.output_index}`;
                const delta = String(event.delta ?? '');
                argsByItem.set(id, (argsByItem.get(id) ?? '') + delta);
                notify({ type: 'tool.args.delta', itemId: id, bytes: Buffer.byteLength(delta) });
                break;
            }
            case 'response.function_call_arguments.done': {
                const item = items.get(event.output_index);
                notify({
                    type: 'tool.args.done', itemId: event.item_id ?? null, name: event.name ?? item?.name ?? null,
                    arguments: event.arguments ?? argsByItem.get(event.item_id) ?? '',
                });
                break;
            }
            case 'response.output_item.done': {
                const item = event.item ?? items.get(event.output_index) ?? {};
                items.set(event.output_index, item);
                if (kindOf(item)) notify({ type: 'builtin.done', kind: kindOf(item), itemId: item.id ?? null, item });
                notify({ type: 'item.done', item });
                break;
            }
            case 'response.completed':
            case 'response.failed':
            case 'response.incomplete':
                response = event.response ?? response;
                break;
            case 'error': {
                // Shape: { type:'error', error:{ type, code, message, param } } (nested) or flat { code, message }.
                const payload = event.error && typeof event.error === 'object' ? event.error : event;
                streamError = new ApiError(`Responses API stream error: ${payload.message ?? payload.code ?? 'unknown'}`, {
                    code: 'STREAM_ERROR', apiCode: payload.code ?? null, apiType: payload.type ?? null, param: payload.param ?? null,
                });
                notify({ type: 'stream.error', code: payload.code ?? null, message: payload.message ?? 'stream error' });
                // Do not throw yet: the API normally follows with response.failed carrying the final state.
                break;
            }
            default: {
                // Progress events of built-in tools: response.<tool>_call.<status>
                const match = /^response\.([a-z_]+_call)(?:_[a-z_]+)?\.([a-z_]+)$/.exec(event.type);
                if (match && BUILTIN_KINDS[match[1]]) {
                    notify({
                        type: 'builtin.progress', kind: BUILTIN_KINDS[match[1]], itemId: event.item_id ?? null,
                        status: match[2], raw: event.type,
                    });
                }
            }
        }
    }

    return {
        handle,
        /**
         * Response object seen so far, or null before response.created.
         * @returns {object|null}
         * @ai.hint pure
         */
        get response() { return response; },
        /**
         * Last SSE sequence_number, or null when none has arrived.
         * @returns {number|null}
         * @ai.hint pure
         */
        get lastSequence() { return lastSequence; },
        /**
         * Error event from the stream, if the API sent one.
         * @returns {ApiError|null}
         * @ai.hint pure
         */
        get streamError() { return streamError; },
        /**
         * Output items in arrival order.
         * @returns {object[]}
         * @ai.hint pure
         */
        get items() { return [...items.values()]; },
        /**
         * Text accumulated so far (useful when the stream was cut before response.completed).
         * @returns {string}
         * @ai.hint pure
         */
        partialText() { return [...textByItem.values()].join(''); },
    };
}

/**
 * Concatenate all assistant output_text parts of a response.
 * @param {object} response
 * @returns {string}
 * @ai.hint pure
 */
export function outputText(response) {
    if (!Array.isArray(response?.output)) return '';
    const parts = [];
    for (const item of response.output) {
        if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
        for (const part of item.content) {
            if (part?.type === 'output_text' && typeof part.text === 'string') parts.push(part.text);
        }
    }
    return parts.join('');
}

/**
 * Refusal text of a response, if any.
 * @param {object} response
 * @returns {string}
 * @ai.hint pure
 */
export function refusalText(response) {
    if (!Array.isArray(response?.output)) return '';
    for (const item of response.output) {
        for (const part of item?.content ?? []) if (part?.type === 'refusal') return String(part.refusal ?? '');
    }
    return '';
}

/**
 * Normalize usage from a response; returns null if the usage block is missing or malformed.
 * @param {object} usage
 * @returns {object|null}
 * @ai.hint pure
 */
export function normalizeUsage(usage) {
    if (!usage || typeof usage !== 'object') return null;
    const int = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
    const input = int(usage.input_tokens);
    const output = int(usage.output_tokens);
    if (!Number.isSafeInteger(usage.input_tokens) || !Number.isSafeInteger(usage.output_tokens)) return null;
    return {
        input, output,
        cached: Math.min(input, int(usage.input_tokens_details?.cached_tokens)),
        reasoning: Math.min(output, int(usage.output_tokens_details?.reasoning_tokens)),
        total: int(usage.total_tokens) || input + output,
    };
}
