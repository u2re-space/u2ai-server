#!/usr/bin/env node
/**
 * @file bin/ai-serve-agent-worker.js
 * @module bin/ai-serve-agent-worker
 * @purpose The worker of the server: the thread or the process that runs the cycle.
 *
 *   As a thread of the parent, the spec comes with the thread. As a process of its own,
 *   the spec comes with the first frame of the channel. Both carry the same cycle of the
 *   model, and both send the calls of the tools back to the parent: the worker never
 *   touches a file by itself.
 *
 * @depends agent/worker-runner
 * @usedBy agent/worker-runner, package bin
 * @ai.tags house, server, worker
 * @ai.hint io
 */
import { parentPort } from 'node:worker_threads';
import { createServerWorker } from '../src/agent/worker-runner.js';

await createServerWorker({ port: parentPort });
