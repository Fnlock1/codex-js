/**
 * 中文模块说明：src/agents/expert-profiles.js
 *
 * 多专家系统的角色档案、自动匹配和子 agent prompt 生成逻辑。
 * 这里不负责执行 agent，只负责决定“用哪个专家”和“专家应该怎么思考”。
 */

export const DEFAULT_EXPERT_PROFILE_ID = "general";

export const DEFAULT_EXPERT_PROFILES = Object.freeze([
  {
    id: "fullstack",
    name: "全栈工程师",
    role: "fullstack_engineer",
    description: "负责中低复杂度需求的端到端实现，能同时处理前端、后端、脚手架、联调和验证。",
    instructions: [
      "优先给出最短可落地路径，避免不必要地拆分前后端专家。",
      "同时关注用户体验、接口数据流、文件结构和启动验证。",
      "当任务复杂度升高或出现明确前后端边界时，建议 Leader 拆分前端和后端专家。"
    ],
    keywords: [
      "fullstack",
      "full-stack",
      "end-to-end",
      "app",
      "website",
      "vue",
      "node",
      "全栈",
      "端到端",
      "应用",
      "网站",
      "官网",
      "页面",
      "项目",
      "脚手架"
    ]
  },
  {
    id: "backend",
    name: "后端工程师",
    role: "backend_engineer",
    description: "负责 API、服务端业务逻辑、数据库、鉴权、任务队列、集成和后端工程质量。",
    instructions: [
      "优先检查接口边界、数据模型、错误处理、鉴权和持久化。",
      "把后端实现拆成清晰的路由、服务、存储和验证步骤。",
      "指出需要和前端约定的请求/响应契约。"
    ],
    keywords: [
      "backend",
      "server",
      "api",
      "database",
      "db",
      "auth",
      "service",
      "node",
      "express",
      "后端",
      "服务端",
      "接口",
      "数据库",
      "鉴权",
      "登录",
      "持久化"
    ]
  },
  {
    id: "architect",
    name: "架构专家",
    role: "architecture_expert",
    description: "负责模块边界、系统设计、可维护性和演进路线。",
    instructions: [
      "优先识别模块边界、数据流和长期维护风险。",
      "给出可以落地的设计建议，避免空泛重构。",
      "指出哪些改动应该保持小步提交，哪些地方需要抽象。"
    ],
    keywords: ["architecture", "architect", "design", "module", "boundary", "架构", "设计", "模块", "边界"]
  },
  {
    id: "tester",
    name: "测试专家",
    role: "test_expert",
    description: "负责测试策略、回归风险、边界条件和验证命令。",
    instructions: [
      "优先找高风险行为和缺失测试。",
      "给出最小但有效的测试组合。",
      "说明哪些验证必须自动化，哪些可以手动冒烟。"
    ],
    keywords: ["test", "spec", "coverage", "regression", "测试", "单测", "覆盖", "回归", "验证"]
  },
  {
    id: "frontend",
    name: "前端专家",
    role: "frontend_expert",
    description: "负责 Vue、交互体验、布局状态和前端工程质量。",
    instructions: [
      "优先检查用户流程、状态同步、可访问性和响应式布局。",
      "建议要贴近现有组件风格。",
      "避免把产品界面做成解释文档。"
    ],
    keywords: ["frontend", "vue", "renderer", "ui", "ux", "css", "前端", "界面", "交互", "组件"]
  },
  {
    id: "security",
    name: "安全专家",
    role: "security_expert",
    description: "负责权限、沙箱、命令执行、文件系统和敏感信息风险。",
    instructions: [
      "优先检查越权读写、命令执行、网络访问和敏感信息泄露。",
      "明确风险等级和可利用条件。",
      "给出不破坏开发体验的防护方案。"
    ],
    keywords: ["security", "sandbox", "permission", "approval", "secret", "安全", "权限", "沙箱", "密钥", "泄露"]
  },
  {
    id: "performance",
    name: "性能专家",
    role: "performance_expert",
    description: "负责性能瓶颈、并发、缓存、I/O 和资源消耗。",
    instructions: [
      "优先识别热路径、重复 I/O、阻塞流程和不必要的大对象复制。",
      "区分真实瓶颈和过早优化。",
      "建议要能用测量结果验证。"
    ],
    keywords: ["performance", "perf", "cache", "latency", "memory", "性能", "缓存", "延迟", "并发"]
  },
  {
    id: "memory",
    name: "记忆系统专家",
    role: "memory_expert",
    description: "负责长期记忆、召回策略、上下文注入和遗忘策略。",
    instructions: [
      "优先检查记忆保存、召回、去噪、scope 隔离和 prompt 注入。",
      "注意记忆不能覆盖最新用户指令和项目规则。",
      "建议要能逐步替换为向量检索或数据库。"
    ],
    keywords: ["memory", "recall", "remember", "embedding", "prompt", "记忆", "召回", "长期", "上下文"]
  },
  {
    id: "tools",
    name: "工具系统专家",
    role: "tooling_expert",
    description: "负责 tool schema、handler、runtime router 和工具调用闭环。",
    instructions: [
      "优先检查工具 schema、参数标准化、handler 返回值和模型可见性。",
      "确认工具失败时有清晰错误，并且不会重复执行危险操作。",
      "关注 tool call 结果是否正确回灌给模型。"
    ],
    keywords: ["tool", "tools", "handler", "runtime", "router", "工具", "调用", "schema"]
  },
  {
    id: DEFAULT_EXPERT_PROFILE_ID,
    name: "通用专家",
    role: "general_expert",
    description: "负责一般代码分析、实现建议和结果汇总。",
    instructions: [
      "先理解任务目标，再给出直接可执行的结论。",
      "保持范围克制，避免无关重构。",
      "输出要清楚标明风险、建议和验证方式。"
    ],
    keywords: ["general", "default", "通用", "默认", "综合"]
  }
]);

/**
 * 返回默认专家档案列表。
 *
 * @returns {object[]} 专家档案列表。
 */
export function listDefaultExpertProfiles() {
  return DEFAULT_EXPERT_PROFILES.map((profile) => ({ ...profile }));
}

/**
 * 根据 id、role 或名称查找专家档案。
 *
 * @param {string} value - 专家 id、role 或名称。
 * @param {object[]} profiles - 可用专家档案。
 * @returns {object|null} 匹配到的专家档案。
 */
export function getExpertProfile(value, profiles = DEFAULT_EXPERT_PROFILES) {
  const normalized = normalizeExpertId(value);

  if (!normalized) {
    return null;
  }

  return normalizeExpertProfiles(profiles).find((profile) => (
    normalizeExpertId(profile.id) === normalized ||
    normalizeExpertId(profile.role) === normalized ||
    normalizeExpertId(profile.name) === normalized
  )) ?? null;
}

/**
 * 根据任务文本和显式参数选择专家档案。
 *
 * @param {object} options - 选择参数。
 * @param {string} options.task - 子任务文本。
 * @param {string} [options.expert] - 显式专家 id。
 * @param {boolean} [options.auto] - 是否允许自动匹配。
 * @param {object[]} [options.profiles] - 可用专家档案。
 * @returns {object} 选中的专家档案。
 */
export function selectExpertProfile(options = {}) {
  const profiles = normalizeExpertProfiles(options.profiles ?? DEFAULT_EXPERT_PROFILES);
  const explicit = getExpertProfile(options.expert ?? options.expertId ?? options.expert_id, profiles);

  if (explicit) {
    return explicit;
  }

  const auto = options.auto ?? true;

  if (auto) {
    const scored = profiles
      .map((profile) => ({
        profile,
        score: scoreExpertProfile(profile, options.task)
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score);

    if (scored.length > 0) {
      return scored[0].profile;
    }
  }

  return getExpertProfile(DEFAULT_EXPERT_PROFILE_ID, profiles) ?? profiles[0];
}

/**
 * 把 agent 和专家档案格式化成子 agent prompt。
 *
 * @param {object} agent - agent 记录。
 * @returns {string} 子 agent prompt。
 */
export function formatExpertAgentPrompt(agent = {}) {
  const expert = agent.metadata?.expert ?? selectExpertProfile({
    task: agent.task,
    expert: agent.role
  });
  const context = agent.metadata?.context
    ? `\nContext:\n${agent.metadata.context}`
    : "";
  const instructions = Array.isArray(expert.instructions)
    ? expert.instructions.map((line) => `- ${line}`).join("\n")
    : "";
  const coordinationRules = [
    "Coordination rules:",
    "- You report only to the technical leader.",
    "- If requirements, files, or constraints are unclear, write a clear question for the technical leader instead of asking the user directly.",
    "- Do not communicate with, reference, or wait for other sub-experts.",
    "- Use only your own expert-private memory plus shared project/user memory."
  ].join("\n");

  if (expert.dynamic && expert.prompt) {
    return [
      String(expert.prompt).trim(),
      coordinationRules,
      `Task:\n${agent.task}${context}`,
      "Return a concise expert report for the technical leader with findings, recommendations, leader questions if any, and verification notes."
    ].filter(Boolean).join("\n\n");
  }

  return [
    `Expert: ${expert.name} (${expert.id})`,
    `Role: ${expert.role}`,
    expert.description ? `Focus: ${expert.description}` : "",
    instructions ? `Instructions:\n${instructions}` : "",
    coordinationRules,
    `Task:\n${agent.task}${context}`,
    "Return a concise expert report for the technical leader with findings, recommendations, leader questions if any, and verification notes."
  ].filter(Boolean).join("\n\n");
}

/**
 * 标准化专家档案列表。
 *
 * @param {object[]} profiles - 原始专家档案。
 * @returns {object[]} 标准专家档案。
 */
export function normalizeExpertProfiles(profiles = DEFAULT_EXPERT_PROFILES) {
  return (Array.isArray(profiles) ? profiles : [])
    .map(normalizeExpertProfile)
    .filter(Boolean);
}

/**
 * 标准化单个专家档案。
 *
 * @param {object} profile - 原始专家档案。
 * @returns {object|null} 标准专家档案。
 */
export function normalizeExpertProfile(profile) {
  if (!profile || typeof profile !== "object") {
    return null;
  }

  const id = normalizeExpertId(profile.id ?? profile.role ?? profile.name);

  if (!id) {
    return null;
  }

  return {
    id,
    name: String(profile.name ?? id),
    role: String(profile.role ?? `${id}_expert`),
    description: String(profile.description ?? ""),
    instructions: normalizeStringArray(profile.instructions),
    keywords: normalizeStringArray(profile.keywords),
    dynamic: Boolean(profile.dynamic ?? false),
    prompt: normalizeOptionalString(profile.prompt ?? profile.systemPrompt ?? profile.system_prompt)
  };
}

/**
 * 计算专家档案与任务文本的匹配分数。
 *
 * @param {object} profile - 专家档案。
 * @param {string} task - 任务文本。
 * @returns {number} 匹配分数。
 */
function scoreExpertProfile(profile, task = "") {
  const text = String(task ?? "").toLowerCase();
  let score = 0;

  for (const keyword of profile.keywords ?? []) {
    const normalized = keyword.toLowerCase();

    if (!normalized) {
      continue;
    }

    if (text.includes(normalized)) {
      score += normalized.length > 2 ? 3 : 1;
    }
  }

  return score;
}

/**
 * 标准化专家 id。
 *
 * @param {unknown} value - 原始值。
 * @returns {string} 标准 id。
 */
function normalizeExpertId(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, "_");
}

/**
 * 标准化字符串数组。
 *
 * @param {unknown} value - 原始数组。
 * @returns {string[]} 字符串数组。
 */
function normalizeStringArray(value) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean);
}

/**
 * 标准化可选字符串。
 *
 * @param {unknown} value - 原始值。
 * @returns {string} 标准字符串。
 */
function normalizeOptionalString(value) {
  return String(value ?? "").trim();
}
