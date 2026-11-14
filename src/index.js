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
