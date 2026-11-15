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
export { runDoctor, formatDoctor, CHECK_STATES } from './cli/doctor.js';

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
    TOOL_REQUEST_TIMEOUT_MS,
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
export {
    decodeFrame,
    validateFrame,
    validateStart,
    validateComplete,
    validateClaim,
    validateToolResult,
} from './shared/decoder.js';

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
export { createHub, attachConnection, attachCompletionSocket } from './server/u2ai.js';
export { createServerAgent, AGENT_COMMANDS, AGENT_INSTRUCTIONS } from './server/agent.js';
export {
    RUN_STATE_FILE,
    changesRel,
    publishServer,
    writeRunState,
    signRun,
} from './server/publish.js';
export {
    HOUSE_DIR,
    HOUSE_TMP,
    HOUSE_ASSETS,
    HOUSE_LOGS,
    HOUSE_WORK,
    MANIFEST_FILE,
    MANIFEST_VERSION,
    HOUSE_SYSTEMS,
    houseDir,
    workRel,
    workDir,
    runStateDir,
    assetsDir,
    logsDir,
    manifestPath,
    toProjectPath,
    readManifest,
    writeManifest,
    publish,
    findGenerated,
    writeFileAtomic,
} from './shared/house.js';
export {
    MCP_PROTOCOL_VERSION,
    MCP_SUPPORTED_PROTOCOLS,
    MCP_ERROR,
    MCP_RESOURCES,
    MCP_PROMPTS,
    mcpToolList,
    mcpClientToolList,
    createMcpServer,
    createMcpHttpHandler,
    startHttpServer,
    newMcpToken,
    errorResponse,
} from './server/mcp.js';
export { startStdioServer } from './server/stdio.js';

export {
    NOISY_DIRS,
    isProtectedFileName,
    isForbiddenDirName,
    toPosix,
    isInside,
    resolveInside,
} from './agent/access.js';
export { createAccess, ACCESS_LIMITS, EXEC_LIMITS } from './access/index.js';
export { createPathAccess, DEFAULT_MESSAGES } from './access/paths.js';
export { createNativeBackend, createNativeFileSystem, createNativeExecutor } from './access/native.js';
export { createMemoryBackend, createMemoryFileSystem, createMemoryExecutor } from './access/memory.js';
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
    TOOL_ALIASES,
    toolDefinitions,
    describeTool,
    toolCategory,
    toolRisk,
    toolsByCategory,
    toolAllowed,
    resolveToolName,
    needsApproval,
    executeToolRequest,
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
export {
    INDEX_HTML_INLINE_BYTES,
    parseJsonc,
    extractHtmlEntries,
    resolveSpecifier,
    mergeTaskDraft,
    formatWorkspace,
    scanWorkspace,
} from './tools/context.js';
export { suggestPaths, suggestCommands, suggest } from './tools/suggest.js';
export {
    AGENT_FILE_NAMES,
    parseMention,
    collectMentions,
    discoverAgents,
    collectRoleContext,
    formatRoleContext,
} from './agent/context.js';
export {
    CLIENT_PROTOCOL_VERSIONS,
    McpError,
    createMcpClient,
    toolText,
} from './client/mcp.js';
export { startNodeServer } from './client/stdio.js';
export { createFetchTransport } from './client/fetch.js';
export { createHttpTransport, mcpUrl } from './client/http.js';
export {
    normalizeServer,
    proxyToolName,
    splitProxyToolName,
    proxyToolDefinition,
    connectServer,
    connectServers,
    createToolProxy,
    normalizeService,
    startServiceProcess,
    connectBus,
    connectService,
    listServices,
    httpUrlOf,
} from './client/proxy.js';

export {
    ROLE_NAMES,
    ROLE_PROMPTS,
    ROLE_TOOLS,
    resolveRoleSettings,
    roleToolNames,
    createRoleAsk,
    runRole,
    runAgent,
} from './roles/index.js';
export { ANALYZER_SCHEMA, analyzerPrompt, shapeAnalysis, analyzeTask } from './roles/analyzer.js';
export { DIRECTOR_SCHEMA, directorPrompt, shapePlan, planWork } from './roles/director.js';
export { EXECUTOR_SCHEMA, executorPrompt, shapeStepReport, executePlan } from './roles/executor.js';
export {
    TOOLER_SCHEMA,
    toolerPrompt,
    parseToolArguments,
    chooseTool,
    callTool,
    runTooler,
    allowedToolNames,
} from './roles/tooler.js';
export { SUGGESTER_SCHEMA, suggesterPrompt, shapeSuggestion, suggestAnswer } from './roles/suggester.js';
export { CALLABLE_INSTRUCTIONS, callablePrompt, runCallable } from './agent/callable.js';
export {
    COMPLETION_INSTRUCTIONS,
    MAX_LINE_BYTES,
    AutocompleteError,
    buildCompletionContext,
    completionPrompt,
    stripCompletion,
    stripDoubledClosers,
    acceptInsertion,
    fitInsertion,
    completeAtCursor,
} from './agent/autocomplete.js';
