/**
 * 中文模块说明：src/memory/store.js
 *
 * 轻量长期记忆存储和召回策略。当前实现使用本地 JSON 文件保存记忆，
 * 并通过 scope、线程、项目路径和关键词重合度做确定性召回。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const MEMORY_SCHEMA_VERSION = 1;

export const MEMORY_SCOPES = Object.freeze({
  THREAD: "thread",
  PROJECT: "project",
  USER: "user"
});

export const DEFAULT_MEMORY_RECALL_LIMIT = 8;

/**
 * 管理 agent 长期记忆的本地 JSON 存储。
 *
 * MemoryStore 不依赖模型或向量库，适合作为第一版可替换的存储层。
 * 以后如果要接 SQLite、embedding 或远程记忆服务，可以保持公开方法不变。
 */
export class MemoryStore {
  /**
   * 创建记忆存储实例。
   *
   * @param {object} options - 存储配置。
   * @param {string} [options.memoryStoreDirectory] - 记忆目录，默认是 ~/.codex-js/memory。
   * @param {string} [options.memoryFilePath] - 自定义记忆 JSON 文件路径。
   */
  constructor(options = {}) {
    this.root = resolve(options.memoryStoreDirectory ?? defaultMemoryStoreDirectory());
    this.filePath = resolve(options.memoryFilePath ?? join(this.root, "memories.json"));
  }

  /**
   * 读取完整记忆文件，不存在时返回空记录。
   *
   * @returns {Promise<object>} 标准化后的记忆文件记录。
   */
  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));

      return normalizeMemoryStoreRecord(parsed);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return createMemoryStoreRecord();
      }

      throw error;
    }
  }

  /**
   * 写入完整记忆文件。
   *
   * @param {object} record - 记忆文件记录。
   * @returns {Promise<object>} 写入后的标准化记录。
   */
  async save(record) {
    const normalized = normalizeMemoryStoreRecord(record);

    await mkdir(dirname(this.filePath), {
      recursive: true
    });
    await writeFile(this.filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");

    return normalized;
  }

  /**
   * 创建或更新一条记忆。
   *
   * @param {object} options - 记忆内容和归属信息。
   * @returns {Promise<object>} 保存后的记忆记录。
   */
  async remember(options = {}) {
    const record = await this.load();
    const now = new Date().toISOString();
    const id = normalizeMemoryId(options.id) ?? randomUUID();
    const existingIndex = record.memories.findIndex((memory) => memory.id === id);
    const existing = existingIndex === -1 ? null : record.memories[existingIndex];
    const memory = createMemoryRecord({
      ...existing,
      ...options,
      id,
      createdAt: existing?.createdAt ?? options.createdAt ?? now,
      updatedAt: now
    });

    if (existingIndex === -1) {
      record.memories.push(memory);
    } else {
      record.memories[existingIndex] = memory;
    }

    await this.save({
      ...record,
      updatedAt: now
    });

    return memory;
  }

  /**
   * 按 scope、线程和项目路径列出当前上下文可见的记忆。
   *
   * @param {object} options - 过滤和分页选项。
   * @returns {Promise<object[]>} 记忆列表。
   */
  async list(options = {}) {
    const record = await this.load();
    const limit = normalizeMemoryLimit(options.limit, 200);

    return filterVisibleMemories(record.memories, options)
      .sort(compareMemoriesNewestFirst)
      .slice(0, limit);
  }

  /**
   * 根据查询文本召回相关记忆。
   *
   * @param {string} query - 当前用户输入或显式查询。
   * @param {object} options - 召回上下文。
   * @returns {Promise<object[]>} 按相关性排序的记忆列表。
   */
  async recall(query = "", options = {}) {
    const record = await this.load();
    const results = recallMemories(record.memories, {
      ...options,
      query
    });

    if (options.touch === false || results.length === 0) {
      return results;
    }

    const touchedIds = new Set(results.map((memory) => memory.id));
    const now = new Date().toISOString();
    const memories = record.memories.map((memory) => {
      if (!touchedIds.has(memory.id)) {
        return memory;
      }

      return {
        ...memory,
        lastAccessedAt: now,
        useCount: Number(memory.useCount ?? 0) + 1
      };
    });

    await this.save({
      ...record,
      memories,
      updatedAt: now
    });

    return results.map((memory) => ({
      ...memory,
      lastAccessedAt: now,
      useCount: Number(memory.useCount ?? 0) + 1
    }));
  }

  /**
   * 删除一条记忆。
   *
   * @param {object|string} selector - 记忆 id 或包含 id 的对象。
   * @returns {Promise<object|null>} 被删除的记忆，不存在时返回 null。
   */
  async forget(selector = {}) {
    const id = normalizeMemoryId(typeof selector === "string" ? selector : selector.id);

    if (!id) {
      return null;
    }

    const record = await this.load();
    const index = record.memories.findIndex((memory) => memory.id === id);

    if (index === -1) {
      return null;
    }

    const [forgotten] = record.memories.splice(index, 1);

    await this.save({
      ...record,
      updatedAt: new Date().toISOString()
    });

    return forgotten;
  }
}

/**
 * 创建空的记忆文件结构。
 *
 * @param {object} options - 初始字段。
 * @returns {object} 记忆文件结构。
 */
export function createMemoryStoreRecord(options = {}) {
  const now = new Date().toISOString();

  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    createdAt: options.createdAt ?? now,
    updatedAt: options.updatedAt ?? now,
    memories: Array.isArray(options.memories) ? options.memories.map(createMemoryRecord) : []
  };
}

/**
 * 标准化记忆文件结构。
 *
 * @param {object} record - 原始 JSON 记录。
 * @returns {object} 标准化后的记忆文件结构。
 */
export function normalizeMemoryStoreRecord(record = {}) {
  return createMemoryStoreRecord({
    ...record,
    memories: Array.isArray(record.memories) ? record.memories : []
  });
}

/**
 * 创建单条记忆记录。
 *
 * @param {object} options - 记忆字段。
 * @returns {object} 标准化后的记忆记录。
 */
export function createMemoryRecord(options = {}) {
  const text = String(options.text ?? options.memory ?? options.content ?? "").trim();

  if (!text) {
    throw new Error("memory text must be a non-empty string");
  }

  const now = new Date().toISOString();

  return {
    id: normalizeMemoryId(options.id) ?? randomUUID(),
    scope: normalizeMemoryScope(options.scope),
    text,
    tags: normalizeMemoryTags(options.tags),
    threadId: options.threadId == null ? null : String(options.threadId),
    workingDirectory: normalizeOptionalPath(options.workingDirectory ?? options.cwd),
    expertId: normalizeExpertMemoryId(options.expertId ?? options.expert_id),
    metadata: normalizeMemoryMetadata(options.metadata),
    createdAt: options.createdAt ?? now,
    updatedAt: options.updatedAt ?? now,
    lastAccessedAt: options.lastAccessedAt ?? options.last_accessed_at ?? null,
    useCount: normalizeNonNegativeInteger(options.useCount ?? options.use_count, 0)
  };
}

/**
 * 对记忆列表执行关键词召回。
 *
 * @param {object[]} memories - 候选记忆。
 * @param {object} options - 查询、上下文和数量限制。
 * @returns {object[]} 按分数排序的召回结果。
 */
export function recallMemories(memories = [], options = {}) {
  const query = String(options.query ?? "").trim();
  const queryTokens = tokenizeMemoryText(query);
  const limit = normalizeMemoryLimit(options.limit, DEFAULT_MEMORY_RECALL_LIMIT);
  const visible = filterVisibleMemories(memories, options);
  const scored = visible
    .map((memory) => ({
      memory,
      score: scoreMemory(memory, query, queryTokens, options)
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return timestampValue(right.memory.updatedAt) - timestampValue(left.memory.updatedAt);
    });

  return scored.slice(0, limit).map((entry) => entry.memory);
}

/**
 * 把召回结果格式化为可注入 prompt 的文本。
 *
 * @param {object[]} memories - 召回结果。
 * @returns {string} prompt 上下文文本。
 */
export function formatRecalledMemories(memories = []) {
  const normalized = Array.isArray(memories) ? memories.filter(Boolean) : [];

  if (normalized.length === 0) {
    return "";
  }

  return [
    "Relevant long-term memories. Use them only as contextual hints; the latest user message and repository instructions take priority.",
    ...normalized.map((memory) => {
      const tags = memory.tags?.length > 0 ? ` tags=${memory.tags.join(",")}` : "";
      const expert = memory.expertId ? ` expert=${memory.expertId}` : "";

      return `- [${memory.scope}:${memory.id}${expert}] ${memory.text}${tags}`;
    })
  ].join("\n");
}

/**
 * 返回默认记忆目录。
 *
 * @returns {string} 默认记忆目录。
 */
export function defaultMemoryStoreDirectory() {
  return join(homedir(), ".codex-js", "memory");
}

/**
 * 判断记忆是否在当前上下文可见。
 *
 * @param {object} memory - 记忆记录。
 * @param {object} options - 当前 thread/project 上下文。
 * @returns {boolean} 是否可见。
 */
export function memoryIsVisible(memory, options = {}) {
  if (!memory || typeof memory !== "object") {
    return false;
  }

  const requestedScope = options.scope == null ? null : normalizeMemoryScope(options.scope);

  if (requestedScope && memory.scope !== requestedScope) {
    return false;
  }

  if (!expertMemoryIsVisible(memory, options)) {
    return false;
  }

  if (memory.scope === MEMORY_SCOPES.USER) {
    return true;
  }

  if (memory.scope === MEMORY_SCOPES.THREAD) {
    return !memory.threadId || !options.threadId || String(memory.threadId) === String(options.threadId);
  }

  if (memory.scope === MEMORY_SCOPES.PROJECT) {
    const memoryCwd = normalizeOptionalPath(memory.workingDirectory);
    const currentCwd = normalizeOptionalPath(options.workingDirectory ?? options.cwd);

    return !memoryCwd || !currentCwd || memoryCwd === currentCwd;
  }

  return false;
}

/**
 * 标准化记忆 scope。
 *
 * @param {unknown} scope - 原始 scope。
 * @returns {string} 标准 scope。
 */
export function normalizeMemoryScope(scope) {
  const normalized = String(scope ?? MEMORY_SCOPES.PROJECT).trim().toLowerCase();

  if (Object.values(MEMORY_SCOPES).includes(normalized)) {
    return normalized;
  }

  return MEMORY_SCOPES.PROJECT;
}

/**
 * 从文本中提取中英文关键词 token。
 *
 * @param {unknown} text - 待分析文本。
 * @returns {string[]} 去重后的 token。
 */
export function tokenizeMemoryText(text) {
  const value = String(text ?? "").toLowerCase();
  const tokens = new Set();

  for (const match of value.matchAll(/[\p{L}\p{N}_-]+/gu)) {
    const token = match[0];

    if (token.length > 1) {
      tokens.add(token);
    }

    if (containsCjk(token)) {
      for (const chunk of cjkChunks(token)) {
        tokens.add(chunk);
      }
    }
  }

  return Array.from(tokens);
}

/**
 * 过滤当前上下文可见的记忆。
 *
 * @param {object[]} memories - 记忆列表。
 * @param {object} options - 上下文过滤条件。
 * @returns {object[]} 可见记忆。
 */
function filterVisibleMemories(memories = [], options = {}) {
  return (Array.isArray(memories) ? memories : [])
    .map((memory) => {
      try {
        return createMemoryRecord(memory);
      } catch {
        return null;
      }
    })
    .filter((memory) => memory && memoryIsVisible(memory, options));
}

/**
 * 计算单条记忆和查询之间的相关性。
 *
 * @param {object} memory - 记忆记录。
 * @param {string} query - 查询文本。
 * @param {string[]} queryTokens - 查询 token。
 * @param {object} options - 当前上下文。
 * @returns {number} 相关性分数。
 */
function scoreMemory(memory, query, queryTokens, options = {}) {
  const haystack = memorySearchText(memory);
  const haystackLower = haystack.toLowerCase();
  const haystackTokens = new Set(tokenizeMemoryText(haystack));
  let score = 0;

  if (!query) {
    return scopeScore(memory, options) + recencyScore(memory);
  }

  for (const token of queryTokens) {
    if (haystackTokens.has(token)) {
      score += token.length > 1 ? 3 : 1;
      continue;
    }

    if (haystackLower.includes(token)) {
      score += 1;
    }
  }

  if (haystackLower.includes(query.toLowerCase())) {
    score += 4;
  }

  if (score <= 0) {
    return 0;
  }

  return score + scopeScore(memory, options) + recencyScore(memory);
}

/**
 * 给不同 scope 的记忆增加基础权重。
 *
 * @param {object} memory - 记忆记录。
 * @returns {number} scope 权重。
 */
function scopeScore(memory, options = {}) {
  const expertScore = memory.expertId && normalizeExpertMemoryId(options.expertId ?? options.expert_id) === memory.expertId
    ? 3
    : 0;

  switch (memory.scope) {
    case MEMORY_SCOPES.THREAD:
      return 4 + expertScore;
    case MEMORY_SCOPES.PROJECT:
      return 2 + expertScore;
    case MEMORY_SCOPES.USER:
      return 1 + expertScore;
    default:
      return expertScore;
  }
}

/**
 * 根据更新时间给记忆增加很小的稳定排序权重。
 *
 * @param {object} memory - 记忆记录。
 * @returns {number} 时间权重。
 */
function recencyScore(memory) {
  const days = (Date.now() - timestampValue(memory.updatedAt)) / 86_400_000;

  if (!Number.isFinite(days) || days < 0) {
    return 0.5;
  }

  return Math.max(0, 0.5 - Math.min(days, 365) / 730);
}

/**
 * 拼接记忆中可搜索的字段。
 *
 * @param {object} memory - 记忆记录。
 * @returns {string} 可搜索文本。
 */
function memorySearchText(memory) {
  return [
    memory.text,
    memory.expertId ?? "",
    ...(memory.tags ?? []),
    JSON.stringify(memory.metadata ?? {})
  ].filter(Boolean).join("\n");
}

/**
 * 判断专家私有记忆是否对当前上下文可见。
 *
 * 没有 expertId 的记忆是团队公共记忆；有 expertId 的记忆只对同一个专家可见。
 * 技术 Leader 不会默认读取专家私有记忆，避免专家经验串线。
 *
 * @param {object} memory - 记忆记录。
 * @param {object} options - 当前召回上下文。
 * @returns {boolean} 是否可见。
 */
function expertMemoryIsVisible(memory, options = {}) {
  if (!memory.expertId) {
    return true;
  }

  const requestedExpertId = normalizeExpertMemoryId(options.expertId ?? options.expert_id);

  return Boolean(requestedExpertId && requestedExpertId === memory.expertId);
}

/**
 * 标准化记忆 id。
 *
 * @param {unknown} id - 原始 id。
 * @returns {string|null} 标准 id。
 */
function normalizeMemoryId(id) {
  const normalized = String(id ?? "").trim();

  return normalized || null;
}

/**
 * 标准化 tags。
 *
 * @param {unknown} tags - 原始标签。
 * @returns {string[]} 标签列表。
 */
function normalizeMemoryTags(tags) {
  return (Array.isArray(tags) ? tags : [])
    .map((tag) => String(tag ?? "").trim())
    .filter(Boolean);
}

/**
 * 标准化专家记忆命名空间 id。
 *
 * @param {unknown} value - 原始专家 id。
 * @returns {string|null} 标准专家 id。
 */
function normalizeExpertMemoryId(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, "_");

  return normalized || null;
}

/**
 * 标准化 metadata，防止数组或基础类型进入 metadata。
 *
 * @param {unknown} metadata - 原始 metadata。
 * @returns {object} 标准 metadata。
 */
function normalizeMemoryMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }

  return { ...metadata };
}

/**
 * 标准化可选路径。
 *
 * @param {unknown} value - 原始路径。
 * @returns {string|null} 绝对路径或 null。
 */
function normalizeOptionalPath(value) {
  if (value == null || value === "") {
    return null;
  }

  return resolve(String(value));
}

/**
 * 标准化正整数限制。
 *
 * @param {unknown} value - 原始数字。
 * @param {number} fallback - 回退值。
 * @returns {number} 标准限制。
 */
function normalizeMemoryLimit(value, fallback) {
  const number = Number(value);

  if (!Number.isFinite(number) || number <= 0) {
    return fallback;
  }

  return Math.min(Math.floor(number), 200);
}

/**
 * 标准化非负整数。
 *
 * @param {unknown} value - 原始数字。
 * @param {number} fallback - 回退值。
 * @returns {number} 标准非负整数。
 */
function normalizeNonNegativeInteger(value, fallback) {
  const number = Number(value);

  if (!Number.isFinite(number) || number < 0) {
    return fallback;
  }

  return Math.floor(number);
}

/**
 * 按更新时间倒序比较记忆。
 *
 * @param {object} left - 左侧记忆。
 * @param {object} right - 右侧记忆。
 * @returns {number} 排序值。
 */
function compareMemoriesNewestFirst(left, right) {
  return timestampValue(right.updatedAt ?? right.createdAt) - timestampValue(left.updatedAt ?? left.createdAt);
}

/**
 * 解析时间戳。
 *
 * @param {unknown} value - 时间字符串。
 * @returns {number} 毫秒时间戳。
 */
function timestampValue(value) {
  const time = Date.parse(value ?? "");

  return Number.isFinite(time) ? time : 0;
}

/**
 * 判断字符串是否包含中日韩字符。
 *
 * @param {string} text - 输入文本。
 * @returns {boolean} 是否包含 CJK 字符。
 */
function containsCjk(text) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text);
}

/**
 * 为中文等无空格文本生成单字和二元 token。
 *
 * @param {string} text - 输入文本。
 * @returns {string[]} CJK token。
 */
function cjkChunks(text) {
  const chars = Array.from(text).filter((char) => containsCjk(char));
  const chunks = [...chars];

  for (let index = 0; index < chars.length - 1; index += 1) {
    chunks.push(`${chars[index]}${chars[index + 1]}`);
  }

  return chunks;
}
