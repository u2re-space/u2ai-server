/**
 * @file src/index.js
 * @module index
 * @purpose Barrel re-export: everything the CLI and the public API use.
 * @ai.hint keep
 */

export { main, EXIT } from './cli.js';
export { parseArgv } from './cli/parser.js';
export { HELP, COMMAND_NAMES } from './help.js';
export { COLORS, paint } from './cli/colors.js';
export { checkNodeVersion, REQUIRED_NODE } from './cli/compatibility.js';

export * from './config.js';

export {
    buildResponsesBody,
    parseResponse,
    extractToolCalls,
    imagePart,
    textPart,
    functionTool,
    parseJsonText,
    createStreamReducer,
    outputText,
    refusalText,
    normalizeUsage,
} from './openai/responses.js';
export {
    createClient,
    resolveBackends,
} from './openai/client.js';
export {
    ApiError,
    isAbortError,
    normalizeBaseURL,
    normalizeHeaders,
    retryDelayMs,
    apiErrorFrom,
} from './openai/http.js';
export { createTransport, readBody, parseSSE } from './openai/fetch.js';
export {
    fallbackChain,
    fallbackModels,
    fallbackWorthy,
    modelRefusal,
    withModelFallback,
} from './openai/fallback.js';
export {
    DECISIONS_PATH,
    buildDecisionBody,
    parseDecisionAnswer,
    validateDecisionQuestions,
} from './openai/decision.js';
export {
    BATCH_ENDPOINT,
    BATCH_WINDOW,
    buildBatchJsonl,
    parseBatchResults,
    batchEndpointFor,
    submitBatch,
    fetchBatch,
    runBatch,
} from './openai/batch.js';
export {
    MODEL_PROFILES,
    getModelProfile,
    snapEffort,
    contextBytes,
    maxOutputFor,
} from './model/profiles.js';

export {
    PROTOCOL_VERSION,
    MAX_FRAME_BYTES,
    MAX_COMPLETION_CONTEXT_BYTES,
    MAX_COMPLETION_FRAME_BYTES,
    COMPLETION_WINDOWS,
    COMMANDS,
    APPROVE_MODES,
    DECISIONS,
    START_FIELDS,
    REJECTED_START_FIELDS,
    FRAME_TYPES,
    EVENT_TYPES,
    PROCESSABLE_TOOLS,
    END_STATUSES,
    ROLES,
    completionWindowLines,
} from './shared/protocol.js';
export {
    sanitizeValue,
    encodeFrame,
    errorFrame,
    readyFrame,
    runStartedFrame,
    runEndedFrame,
    runEventFrame,
    completionFrame,
    buildCompletionFrame,
} from './shared/encoder.js';
export { decodeFrame, validateFrame, validateStart, validateComplete } from './shared/decoder.js';

export {
    WS_GUID,
    CLOSE,
    WsConnection,
    acceptKey,
    encodeWsFrame,
    listenWebSocket,
} from './server/ws.js';
export { HTTP_ROUTES, checkToken, requestToken, readJsonBody, createHttpHandler } from './server/http.js';
export { SERVE_FILE_MODE, pidAlive, readServeRecord, writeServeRecord, startServe } from './server/serve.js';
export { createHub, attachConnection } from './server/u2ai.js';

export {
    NOISY_DIRS,
    isProtectedFileName,
    isForbiddenDirName,
    toPosix,
    isInside,
    resolveInside,
    createAccess,
} from './agent/access.js';
export { formatBytes, formatDuration, truncateText } from './shared/format.js';
export {
    listFiles,
    readTextFile,
    searchFiles,
    writeTextFile,
    replaceInFile,
    deleteFile,
    makeDirectory,
    copyPath,
    isBinaryFile,
} from './tools/filesystem.js';
export {
    TOOL_SPECS,
    TOOL_NAMES,
    TOOL_CATEGORIES,
    TOOL_RISKS,
    toolDefinitions,
    describeTool,
    toolCategory,
    toolRisk,
    toolsByCategory,
    executeTool,
} from './tools/tools.js';
export {
    SHELLS,
    MAX_COMMAND_TIMEOUT_MS,
    childEnvironment,
    scriptLaunch,
    runCommand,
    runProgram,
} from './tools/terminal.js';
export { assessCommandRisk, rewriteCommandText, guardCommandInput } from './tools/command-risk.js';
export { createToolCache } from './tools/cache.js';
export { FILE_COMMANDS_SCHEMA, CommandBatchError, executeFileCommands } from './tools/file-commands.js';
