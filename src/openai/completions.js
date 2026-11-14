/**
 * @file src/openai/completions.js
 * @module openai/completions
 * @purpose Chat Completions adapter: the transport for hosts without the Responses route.
 * @depends openai/chat
 * @usedBy openai/client
 * @exports All of the Chat Completions helpers.
 * @ai.hint keep
 * @ai.hint legacy-0.2
 */
export * from './chat.js';
