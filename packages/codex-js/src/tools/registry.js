/**
 * 中文模块说明：src/tools/registry.js
 *
 * 工具定义、路由、handler、内置工具和上游工具格式转换。
 */
export const TOOL_SPEC_TYPES = Object.freeze({
  FUNCTION: "function"
});

/**
 * 定义 ToolRegistry 类，封装当前模块的状态和行为。
 */
export class ToolRegistry {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} options - options 参数。
   */
  constructor(options = {}) {
    this.tools = new Map();

    for (const tool of options.tools ?? []) {
      this.register(tool);
    }
  }

  /**
   * 处理 empty 相关逻辑。
   * @returns {unknown} 返回处理后的结果。
   */
  static empty() {
    return new ToolRegistry();
  }

  /**
   * 处理 register 相关逻辑。
   *
   * @param {unknown} tool - tool 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  register(tool) {
    const entry = normalizeToolEntry(tool);

    if (this.tools.has(entry.name)) {
      throw new Error(`Tool already registered: ${entry.name}`);
    }

    this.tools.set(entry.name, entry);
    return entry;
  }

  /**
   * 处理 unregister 相关逻辑。
   *
   * @param {unknown} name - name 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  unregister(name) {
    return this.tools.delete(normalizeToolName(name));
  }

  /**
   * 判断是否存在 has 相关数据。
   *
   * @param {unknown} name - name 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  has(name) {
    return this.tools.has(normalizeToolName(name));
  }

  /**
   * 获取 get 相关数据。
   *
   * @param {unknown} name - name 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  get(name) {
    return this.tools.get(normalizeToolName(name)) ?? null;
  }

  /**
   * 列出 list 相关数据。
   * @returns {unknown} 返回处理后的结果。
   */
  list() {
    return Array.from(this.tools.values()).map((entry) => ({
      ...entry,
      spec: { ...entry.spec }
    }));
  }

  /**
   * 处理 model visible specs 相关逻辑。
   * @returns {unknown} 返回处理后的结果。
   */
  modelVisibleSpecs(options = {}) {
    return this.list()
      .filter((entry) => {
        const exposure = entry.metadata?.exposure ?? "model_visible";

        if (exposure !== "model_visible") {
          return false;
        }

        if (entry.metadata?.expertTeamOnly && !options.expertTeam) {
          return false;
        }

        return true;
      })
      .map((entry) => entry.spec);
  }
}

/**
 * 归一化 normalize tool entry 相关数据。
 *
 * @param {unknown} tool - tool 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeToolEntry(tool) {
  if (!tool || typeof tool !== "object") {
    throw new TypeError("Tool entry must be an object.");
  }

  const spec = normalizeToolSpec(tool.spec ?? tool);

  return {
    name: spec.name,
    spec,
    handler: tool.handler ?? null,
    metadata: tool.metadata ?? null
  };
}

/**
 * 归一化 normalize tool spec 相关数据。
 *
 * @param {unknown} spec - spec 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeToolSpec(spec) {
  if (!spec || typeof spec !== "object") {
    throw new TypeError("Tool spec must be an object.");
  }

  const name = normalizeToolName(spec.name);
  const outputSchema = spec.outputSchema ?? spec.output_schema ?? null;
  const normalized = {
    ...spec,
    type: spec.type ?? TOOL_SPEC_TYPES.FUNCTION,
    name,
    description: String(spec.description ?? ""),
    strict: Boolean(spec.strict ?? false),
    parameters: spec.parameters ?? {},
    output_schema: outputSchema
  };

  delete normalized.outputSchema;
  return normalized;
}

/**
 * 归一化 normalize tool name 相关数据。
 *
 * @param {unknown} name - name 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeToolName(name) {
  const normalized = String(name ?? "").trim();

  if (!normalized) {
    throw new Error("Tool name is required.");
  }

  return normalized;
}
