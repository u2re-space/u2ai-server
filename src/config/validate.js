/**
 * Validation of the merged configuration against the enums and the
 * allow-lists of defaults. Every failure names the exact config path so the
 * CLI can print one actionable line.
 *
 * The messages are in Russian: the config is the part of the CLI a user edits
 * by hand, and the sibling packages speak Russian there.
 *
 * @ai.hint keep
 */

import { ENUMS, HEADER_NAME, SUPPORT_ALIASES } from './constants.js';
import { defaults, ROLE_FIELDS } from './defaults.js';
import { isRecord } from './merge.js';
import { familyName, groupName } from '../model/refs.js';

/**
 * Check that a reference to a family or a group names one that exists.
 * @param {unknown} ref the reference: a model, `family:<name>` or `group:<name>`
 * @param {string} where the path of the reference
 * @param {(message: string) => never} fail
 * @param {object} config the merged config
 */
function checkModelRef(ref, where, fail, config) {
  const family = familyName(ref);
  if (family && !Object.hasOwn(config.modelFamilies ?? {}, family)) {
    fail(`${where}: семейство моделей "${family}" не найдено (modelFamilies)`);
  }
  const group = groupName(ref);
  if (group && !Object.hasOwn(config.modelGroups ?? {}, group)) {
    fail(`${where}: группа моделей "${group}" не найдена (modelGroups)`);
  }
}

/**
 * Validate the families of models: { "<name>": ["<model>", ...] }.
 * @param {unknown} families
 * @param {(message: string) => never} fail
 */
function validateModelFamilies(families, fail) {
  if (!isRecord(families)) fail('modelFamilies должен быть объектом');
  for (const [name, list] of Object.entries(families)) {
    if (!name.trim()) fail('modelFamilies: пустое имя семейства');
    if (!Array.isArray(list) || !list.length) fail(`modelFamilies.${name}: непустой массив моделей`);
    for (const item of list) {
      if (typeof item !== 'string' || !item.trim()) fail(`modelFamilies.${name}: непустая строка`);
    }
  }
}

/**
 * Validate the groups of models: { "<name>": ["<model>" | { model, maxContext }] }.
 * @param {unknown} groups
 * @param {(message: string) => never} fail
 */
function validateModelGroups(groups, fail) {
  if (!isRecord(groups)) fail('modelGroups должен быть объектом');
  for (const [name, list] of Object.entries(groups)) {
    if (!name.trim()) fail('modelGroups: пустое имя группы');
    if (!Array.isArray(list) || !list.length) fail(`modelGroups.${name}: непустой массив моделей`);
    for (const [index, item] of list.entries()) {
      const where = `modelGroups.${name}[${index}]`;
      if (typeof item === 'string') {
        if (!item.trim()) fail(`${where}: непустая строка`);
        continue;
      }
      if (!isRecord(item)) fail(`${where}: строка или объект`);
      for (const key of Object.keys(item)) {
        if (!['model', 'maxContext'].includes(key)) fail(`${where}.${key}: неизвестное поле`);
      }
      if (typeof item.model !== 'string' || !item.model.trim()) fail(`${where}.model: непустая строка`);
      if (item.maxContext != null && !(Number.isSafeInteger(item.maxContext) && item.maxContext > 0)) {
        fail(`${where}.maxContext: целое > 0`);
      }
    }
  }
}

/**
 * Validate the house of the run: the ranks of the models of the house in their families.
 * @param {unknown} house
 * @param {(message: string) => never} fail
 */
function validateHouse(house, fail) {
  const where = 'house';
  if (!isRecord(house)) fail(`${where} должен быть объектом`);
  for (const key of Object.keys(house)) {
    if (key !== 'ranks') fail(`${where}.${key}: неизвестное поле (допустимо: ranks)`);
  }
  const ranks = house.ranks;
  if (!isRecord(ranks)) fail(`${where}.ranks должен быть объектом`);
  for (const key of Object.keys(ranks)) {
    if (key === 'stages') {
      fail(`${where}.ranks.stages: раздел больше не поддерживается — лестница рангов принадлежит `
        + 'роли (house.ranks.roles), а стадия наследует её; удалите раздел из конфигурации.');
    }
    if (key !== 'roles') fail(`${where}.ranks.${key}: неизвестное поле (допустимо: roles)`);
  }
  for (const part of ['roles']) {
    const map = ranks[part];
    if (!isRecord(map)) fail(`${where}.ranks.${part} должен быть объектом`);
    for (const [name, path] of Object.entries(map)) {
      if (!name.trim()) fail(`${where}.ranks.${part}: пустое имя`);
      const list = Array.isArray(path) ? path : [path];
      if (!list.length) fail(`${where}.ranks.${part}.${name}: непустой список рангов`);
      for (const rank of list) {
        if (!(Number.isSafeInteger(rank) && rank >= 0)) fail(`${where}.ranks.${part}.${name}: целое >= 0 или список целых`);
      }
    }
  }
}

/**
 * Validate an optional header map: token names, single-line string values.
 * @param {unknown} headers
 * @param {string} where
 * @param {(message: string) => never} fail
 */
function validateHeaders(headers, where, fail) {
  if (headers == null) return;
  if (!isRecord(headers)) fail(`${where} должен быть объектом`);
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name)) fail(`${where}.${name}: некорректное имя заголовка`);
    if (typeof value !== 'string' || /[\r\n]/.test(value)) fail(`${where}.${name}: строка без перевода строки`);
  }
}

/** Normalize + validate a backend `supports` map via the alias table. */
function validateSupports(supports, where, fail) {
  if (supports == null) return;
  if (!isRecord(supports)) fail(`${where} должен быть объектом`);
  for (const [rawKey, value] of Object.entries(supports)) {
    const key = SUPPORT_ALIASES[rawKey.toLowerCase()] ?? rawKey;
    if (!ENUMS.backendRoutes.includes(key)) fail(`${where}.${rawKey}: ${ENUMS.backendRoutes.join(' | ')}`);
    if (typeof value !== 'boolean') fail(`${where}.${rawKey}: true | false`);
  }
}

/**
 * Validate one backend list (backends).
 * @param {unknown} list
 * @param {string} where
 * @param {(message: string) => never} fail
 */
function validateBackendList(list, where, fail) {
  if (!Array.isArray(list)) fail(`${where} должен быть массивом`);
  for (const [index, item] of list.entries()) {
    if (!isRecord(item)) fail(`${where}[${index}] должен быть объектом`);
    const entry = `${where}[${index}]`;
    for (const key of Object.keys(item)) {
      if (!['baseURL', 'apiKey', 'env', 'headers', 'body', 'supports'].includes(key)) fail(`${entry}.${key}: неизвестное поле`);
    }
    if (typeof item.baseURL !== 'string' || !item.baseURL.trim()) fail(`${entry}.baseURL должен быть URL`);
    try { new URL(item.baseURL); } catch { fail(`${entry}.baseURL должен быть URL`); }
    if (item.apiKey != null && (typeof item.apiKey !== 'string' || /[\r\n]/.test(item.apiKey))) fail(`${entry}.apiKey: строка или null`);
    if (item.env != null && (typeof item.env !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(item.env))) fail(`${entry}.env: имя переменной или null`);
    validateHeaders(item.headers, `${entry}.headers`, fail);
    validateSupports(item.supports, `${entry}.supports`, fail);
  }
}

/** Validate per-model backend lists: { model: [{ baseURL, ... }] }. */
function validateModelBackends(map, fail) {
  if (!isRecord(map)) fail('modelsBackends должен быть объектом');
  for (const [model, list] of Object.entries(map)) {
    if (!model.trim()) fail('modelsBackends: ключ модели не должен быть пустым');
    if (!Array.isArray(list) || !list.length) fail(`modelsBackends.${model} должен быть непустым массивом`);
    for (const [index, item] of list.entries()) {
      const entry = `modelsBackends.${model}[${index}]`;
      if (!isRecord(item)) fail(`${entry} должен быть объектом`);
      for (const key of Object.keys(item)) {
        if (!['baseURL', 'apiKey', 'prefix', 'vendor', 'suffix', 'type'].includes(key)) fail(`${entry}.${key}: неизвестное поле`);
      }
      if (typeof item.baseURL !== 'string' || !item.baseURL.trim()) fail(`${entry}.baseURL должен быть URL`);
      try { new URL(item.baseURL); } catch { fail(`${entry}.baseURL должен быть URL`); }
      if (item.apiKey != null && (typeof item.apiKey !== 'string' || /[\r\n]/.test(item.apiKey))) fail(`${entry}.apiKey: строка или null`);
      if (item.type != null && !['auto', 'text'].includes(item.type)) fail(`${entry}.type: auto | text`);
    }
  }
}

/**
 * Validate one external MCP server entry.
 * @param {unknown} server
 * @param {string} where
 * @param {(message: string) => never} fail
 */
function validateMcpServer(server, where, fail) {
  if (!isRecord(server)) fail(`${where}: объект`);
  if (server.name != null && (typeof server.name !== 'string' || !server.name.trim())) fail(`${where}.name: непустая строка или null`);
  if (server.url != null && (typeof server.url !== 'string' || !server.url.trim())) fail(`${where}.url: непустая строка или null`);
  if (server.command != null && (typeof server.command !== 'string' || !server.command.trim())) fail(`${where}.command: непустая строка или null`);
  if (!server.url && !server.command) fail(`${where}: нужен url или command`);
  if (server.args != null && !Array.isArray(server.args)) fail(`${where}.args: массив строк или null`);
  if (server.env != null && !isRecord(server.env)) fail(`${where}.env: объект или null`);
  if (server.timeoutMs != null && !(Number.isSafeInteger(server.timeoutMs) && server.timeoutMs > 0)) fail(`${where}.timeoutMs: целое > 0`);
}

/**
 * Validate one external service entry: another `ai-serve` we talk to.
 *
 * The service is either running somewhere else (`url`) or is started by us
 * (`command`); a service may also name the file with its address (`file`).
 * @param {unknown} service
 * @param {string} where
 * @param {(message: string) => never} fail
 */
function validateService(service, where, fail) {
  if (!isRecord(service)) fail(`${where}: объект`);
  if (typeof service.name !== 'string' || !service.name.trim()) fail(`${where}.name: непустая строка`);
  const hasUrl = typeof service.url === 'string' && service.url.trim();
  const hasCommand = typeof service.command === 'string' && service.command.trim();
  const hasFile = typeof service.file === 'string' && service.file.trim();
  if (service.url != null && !hasUrl) fail(`${where}.url: непустая строка`);
  if (service.command != null && !hasCommand) fail(`${where}.command: непустая строка`);
  if (!hasUrl && !hasCommand && !hasFile) fail(`${where}: нужен url, command или file`);
  if (service.token != null && typeof service.token !== 'string') fail(`${where}.token: строка или null`);
  if (service.args != null && !Array.isArray(service.args)) fail(`${where}.args: массив строк или null`);
  if (service.cwd != null && typeof service.cwd !== 'string') fail(`${where}.cwd: строка или null`);
  if (service.file != null && typeof service.file !== 'string') fail(`${where}.file: строка или null`);
  if (service.enabled != null && typeof service.enabled !== 'boolean') fail(`${where}.enabled: true | false`);
}

/**
 * Throw when any merged value is outside the accepted enums and ranges.
 * @param {object} config
 * @returns {void}
 */
export function validateConfig(config) {
  const fail = (message) => { throw new Error(`Конфигурация: ${message}`); };
  const c = config;

  if (typeof c.model !== 'string' || !c.model.trim()) fail('укажите model (или AI_SERVE_MODEL / --model).');
  checkModelRef(c.model, 'model', fail, c);
  if (typeof c.baseURL !== 'string' || !c.baseURL.trim()) fail('baseURL должен быть URL.');
  try { new URL(c.baseURL); } catch { fail('baseURL должен быть URL.'); }
  if (c.apiKey !== null && (typeof c.apiKey !== 'string' || /[\r\n]/.test(c.apiKey))) fail('apiKey: строка или null.');

  if (!isRecord(c.models)) fail('models должен быть объектом');
  for (const [modelId, profile] of Object.entries(c.models)) {
    if (!isRecord(profile)) fail(`models.${modelId} должен быть объектом`);
    for (const key of Object.keys(profile)) {
      if (!['window', 'maxOutput', 'ceiling'].includes(key)) fail(`models.${modelId}.${key}: неизвестное поле`);
    }
    if (profile.window != null && !(Number.isSafeInteger(profile.window) && profile.window > 0)) fail(`models.${modelId}.window: целое > 0`);
    if (profile.maxOutput != null && !(Number.isSafeInteger(profile.maxOutput) && profile.maxOutput > 0)) fail(`models.${modelId}.maxOutput: целое > 0`);
    if (profile.ceiling != null && !ENUMS.reasoningEfforts.includes(profile.ceiling)) fail(`models.${modelId}.ceiling: ${ENUMS.reasoningEfforts.join(' | ')}`);
  }

  validateModelFamilies(c.modelFamilies, fail);
  validateModelGroups(c.modelGroups, fail);
  validateHouse(c.house, fail);

  if (!isRecord(c.reasoning)) fail('reasoning должен быть объектом');
  for (const key of Object.keys(c.reasoning)) if (!(key in defaults.reasoning)) fail(`reasoning.${key}: неизвестное поле`);
  if (c.reasoning.effort !== null && !ENUMS.reasoningEfforts.includes(c.reasoning.effort)) fail(`reasoning.effort: ${ENUMS.reasoningEfforts.join(' | ')}`);
  if (c.reasoning.summary !== null && !ENUMS.reasoningSummaries.includes(c.reasoning.summary)) fail(`reasoning.summary: ${ENUMS.reasoningSummaries.join(' | ')}`);
  if (c.reasoning.mode !== null && c.reasoning.mode !== undefined && !ENUMS.reasoningModes.includes(c.reasoning.mode)) fail(`reasoning.mode: ${ENUMS.reasoningModes.join(' | ')}`);
  if (c.verbosity !== null && !['low', 'medium', 'high'].includes(c.verbosity)) fail('verbosity: low | medium | high');
  if (c.temperature !== null && !(Number.isFinite(c.temperature) && c.temperature >= 0 && c.temperature <= 2)) fail('temperature: 0..2');
  if (c.maxOutputTokens !== null && !(Number.isSafeInteger(c.maxOutputTokens) && c.maxOutputTokens >= 16)) fail('maxOutputTokens ≥ 16');
  if (typeof c.store !== 'boolean') fail('store: true | false');
  if (!['auto', 'disabled'].includes(c.truncation)) fail('truncation: auto | disabled');
  if (!Number.isSafeInteger(c.retries) || c.retries < 0 || c.retries > 10) fail('retries: 0..10');
  if (!Number.isSafeInteger(c.timeoutMs) || c.timeoutMs < 5_000 || c.timeoutMs > 600_000) fail('timeoutMs: 5000..600000');

  validateBackendList(c.backends, 'backends', fail);
  validateModelBackends(c.modelsBackends, fail);
  if (!isRecord(c.fallback)) fail('fallback должен быть объектом');
  if (typeof c.fallback.enabled !== 'boolean') fail('fallback.enabled: true | false');
  if (c.fallback.models !== undefined) {
    if (!isRecord(c.fallback.models)) fail('fallback.models должен быть объектом');
    for (const [modelId, chain] of Object.entries(c.fallback.models)) {
      if (!modelId.trim()) fail('fallback.models: пустое имя модели');
      if (!Array.isArray(chain)) fail(`fallback.models.${modelId}: массив моделей`);
      for (const item of chain) {
        const id = typeof item === 'string' ? item : item?.model;
        if (typeof id !== 'string' || !id.trim()) fail(`fallback.models.${modelId}: непустая строка или { model }`);
      }
    }
  }

  for (const [key, value] of Object.entries(c.limits)) {
    if (!(key in defaults.limits)) fail(`неизвестный лимит limits.${key}`);
    if (!(Number.isSafeInteger(value) && value > 0)) fail(`limits.${key}: положительное целое`);
  }

  for (const [key, value] of Object.entries(c.tools)) {
    if (!(key in defaults.tools) || typeof value !== 'boolean') fail(`tools.${key}: true | false (известные: ${Object.keys(defaults.tools).join(', ')})`);
  }
  if (c.tools.allowWrite === false && c.tools.terminal === true) {
    fail('tools.terminal требует tools.allowWrite: true — иначе терминал может обойти запрет записи.');
  }

  if (!isRecord(c.browser)) fail('browser должен быть объектом');
  for (const key of Object.keys(c.browser)) {
    if (!(key in defaults.browser)) fail(`browser.${key}: неизвестное поле (допустимо: ${Object.keys(defaults.browser).join(', ')})`);
  }
  if (!['auto', 'ego', 'chrome'].includes(c.browser.engine)) fail('browser.engine: auto | ego | chrome');
  if (c.browser.executable !== null && (typeof c.browser.executable !== 'string' || !c.browser.executable.trim())) {
    fail('browser.executable: непустая строка или null');
  }
  if (!Number.isSafeInteger(c.browser.timeoutMs) || c.browser.timeoutMs < 1000) fail('browser.timeoutMs: целое от 1000');
  if (!isRecord(c.browser.viewport)) fail('browser.viewport должен быть объектом');
  for (const key of ['width', 'height']) {
    if (!Number.isSafeInteger(c.browser.viewport[key]) || c.browser.viewport[key] < 100) fail(`browser.viewport.${key}: целое от 100`);
  }

  if (!isRecord(c.server)) fail('server должен быть объектом');
  for (const key of Object.keys(c.server)) if (!(key in defaults.server)) fail(`server.${key}: неизвестное поле`);
  if (typeof c.server.host !== 'string' || !c.server.host.trim()) fail('server.host: непустая строка');
  if (!Number.isSafeInteger(c.server.port) || c.server.port < 0 || c.server.port > 65535) fail('server.port: 0..65535');
  if (!ENUMS.approveModes.includes(c.server.approve)) fail(`server.approve: ${ENUMS.approveModes.join(' | ')}`);
  if (typeof c.server.writeServeFile !== 'boolean') fail('server.writeServeFile: true | false');
  for (const key of ['idleTimeoutMs', 'pingIntervalMs']) {
    if (!(Number.isSafeInteger(c.server[key]) && c.server[key] > 0)) fail(`server.${key}: целое > 0`);
  }

  if (!isRecord(c.completion)) fail('completion должен быть объектом');
  for (const key of Object.keys(c.completion)) if (!(key in defaults.completion)) fail(`completion.${key}: неизвестное поле`);
  if (typeof c.completion.enabled !== 'boolean') fail('completion.enabled: true | false');
  if (!Array.isArray(c.completion.tokens)) fail('completion.tokens: массив строк');
  for (const token of c.completion.tokens) {
    if (typeof token !== 'string' || !token.trim()) fail('completion.tokens: непустая строка');
  }
  if (c.completion.model !== null && (typeof c.completion.model !== 'string' || !c.completion.model.trim())) fail('completion.model: строка или null');
  checkModelRef(c.completion.model, 'completion.model', fail, c);
  if (c.completion.effort !== null && !ENUMS.reasoningEfforts.includes(c.completion.effort)) fail(`completion.effort: ${ENUMS.reasoningEfforts.join(' | ')}`);

  if (!isRecord(c.mcp)) fail('mcp должен быть объектом');
  for (const key of Object.keys(c.mcp)) if (!(key in defaults.mcp)) fail(`mcp.${key}: неизвестное поле`);
  if (typeof c.mcp.enabled !== 'boolean') fail('mcp.enabled: true | false');
  if (!ENUMS.mcpTransports.includes(c.mcp.transport)) fail(`mcp.transport: ${ENUMS.mcpTransports.join(' | ')}`);
  if (!Number.isSafeInteger(c.mcp.port) || c.mcp.port < 0 || c.mcp.port > 65535) fail('mcp.port: 0..65535');
  if (typeof c.mcp.listTools !== 'boolean') fail('mcp.listTools: true | false');

  if (!Array.isArray(c.mcpServers)) fail('mcpServers: массив серверов');
  c.mcpServers.forEach((server, index) => validateMcpServer(server, `mcpServers[${index}]`, fail));

  if (!Array.isArray(c.services)) fail('services: массив сервисов');
  c.services.forEach((service, index) => validateService(service, `services[${index}]`, fail));

  if (!isRecord(c.roles)) fail('roles должен быть объектом');
  for (const [name, role] of Object.entries(c.roles)) {
    if (!name.trim()) fail('roles: пустое имя роли');
    if (!isRecord(role)) fail(`roles.${name} должен быть объектом`);
    for (const key of Object.keys(role)) {
      if (!ROLE_FIELDS.includes(key)) fail(`roles.${name}.${key}: неизвестное поле`);
    }
    if (role.model != null && (typeof role.model !== 'string' || !role.model.trim())) fail(`roles.${name}.model: строка или null`);
    checkModelRef(role.model, `roles.${name}.model`, fail, c);
    if (role.effort != null && !ENUMS.reasoningEfforts.includes(role.effort)) fail(`roles.${name}.effort: ${ENUMS.reasoningEfforts.join(' | ')}`);
    if (role.maxEffort != null && !ENUMS.reasoningEfforts.includes(role.maxEffort)) fail(`roles.${name}.maxEffort: ${ENUMS.reasoningEfforts.join(' | ')}`);
    if (role.context != null && !(ENUMS.contextWords.includes(role.context) || (Number.isSafeInteger(role.context) && role.context > 0))) fail(`roles.${name}.context: ${ENUMS.contextWords.join(' | ')} или байты`);
    if (role.tools != null && !Array.isArray(role.tools)) fail(`roles.${name}.tools: массив имён или null`);
    if (role.instructions != null && typeof role.instructions !== 'string') fail(`roles.${name}.instructions: строка или null`);
  }

  if (!isRecord(c.customRoles)) fail('customRoles должен быть объектом');
  if (c.skills != null) {
    if (!isRecord(c.skills)) fail('skills должен быть объектом');
    if (c.skills.dir !== null && (typeof c.skills.dir !== 'string' || !c.skills.dir.trim())) fail('skills.dir: путь или null');
  }
}
