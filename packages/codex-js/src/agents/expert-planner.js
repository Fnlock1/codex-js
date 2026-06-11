/**
 * 中文模块说明：src/agents/expert-planner.js
 *
 * 多专家智慧调度层。它负责把一个用户任务拆成专家计划，
 * 决定要派哪些专家、每个专家看什么、最后怎么汇总。
 */
import {
  DEFAULT_EXPERT_PROFILES,
  getExpertProfile,
  normalizeExpertProfiles,
  selectExpertProfile
} from "./expert-profiles.js";

export const DEFAULT_EXPERT_PLAN_LIMIT = 5;

/**
 * 为一个任务生成多专家执行计划。
 *
 * @param {object} options - 计划参数。
 * @param {string} options.task - 用户任务。
 * @param {string[]} [options.experts] - 显式指定专家 id。
 * @param {object[]} [options.customExperts] - 技术 Leader 动态创建的专家档案。
 * @param {number} [options.limit] - 最多专家数量。
 * @param {object[]} [options.profiles] - 可用专家档案。
 * @returns {object} 专家执行计划。
 */
export function planExperts(options = {}) {
  const task = String(options.task ?? "").trim();

  if (!task) {
    throw new Error("plan_experts requires a non-empty task");
  }

  const profiles = normalizeExpertProfiles([
    ...(options.profiles ?? DEFAULT_EXPERT_PROFILES),
    ...normalizeCustomExperts(options.customExperts ?? options.custom_experts)
  ]);
  const limit = normalizePlanLimit(options.limit ?? options.maxExperts ?? options.max_experts);
  const explicitExperts = normalizeExpertIds(options.experts ?? options.expert_ids);
  const selected = [];
  const complexity = analyzeTaskComplexity(task);

  for (const expertId of explicitExperts) {
    const profile = getExpertProfile(expertId, profiles);

    if (profile && !selected.some((entry) => entry.id === profile.id)) {
      selected.push(profile);
    }
  }

  if (explicitExperts.length === 0) {
    for (const expertId of recommendedPrimaryExperts(complexity)) {
      const profile = getExpertProfile(expertId, profiles);

      if (profile && selected.length < limit && !selected.some((entry) => entry.id === profile.id)) {
        selected.push(profile);
      }
    }

    for (const expertId of recommendedCoverageExperts(complexity, complexity.wantsImplementation, task.toLowerCase())) {
      const profile = getExpertProfile(expertId, profiles);

      if (profile && selected.length < limit && !selected.some((entry) => entry.id === profile.id)) {
        selected.push(profile);
      }
    }
  }

  for (const profile of rankExpertProfiles(task, profiles, complexity)) {
    if (selected.length >= limit) {
      break;
    }

    if (!selected.some((entry) => entry.id === profile.id)) {
      selected.push(profile);
    }
  }

  if (selected.length === 0) {
    selected.push(selectExpertProfile({
      task,
      profiles
    }));
  }

  const finalExperts = ensureCoordinatorCoverage(selected, task, profiles, limit, complexity);
  const assignments = finalExperts.slice(0, limit).map((expert, index) => createExpertAssignment(expert, {
    task,
    index
  }));
  const taskAnalysis = createTaskAnalysis(complexity, assignments);

  return {
    task,
    taskAnalysis,
    contextPolicy: createContextPolicy(task, assignments, complexity),
    executionHints: createExecutionHints(assignments, complexity),
    outputPolicy: createOutputPolicy(complexity),
    strategy: createPlanStrategy(task, assignments),
    assignments,
    summaryPrompt: createSummaryPrompt(task, assignments),
    spawnSequence: assignments.map((assignment) => ({
      tool: "spawn_agent",
      arguments: {
        task: assignment.task,
        expert: assignment.expert.id,
        expert_profile: assignment.expertProfile,
        context: assignment.context,
        mode: "manual"
      }
    })),
    waitSequence: assignments.map((assignment) => ({
      tool: "wait_agent",
      agentIdFromSpawnStep: assignment.id
    })),
    dynamicExperts: profiles
      .filter((profile) => profile.dynamic)
      .map((profile) => ({
        id: profile.id,
        name: profile.name,
        role: profile.role,
        description: profile.description,
        prompt: profile.prompt
      }))
  };
}

/**
 * 把专家计划格式化成给模型看的操作说明。
 *
 * @param {object} plan - 专家计划。
 * @returns {string} 可读计划文本。
 */
export function formatExpertPlan(plan = {}) {
  const assignments = Array.isArray(plan.assignments) ? plan.assignments : [];

  return [
    `Strategy: ${plan.strategy ?? "Use experts, wait for results, then summarize."}`,
    "Assignments:",
    ...assignments.map((assignment, index) => (
      `${index + 1}. ${assignment.expert.name} (${assignment.expert.id}) - ${assignment.task}`
    )),
    "",
    `Summary: ${plan.summaryPrompt ?? ""}`
  ].join("\n");
}

export function analyzeExpertPlanningTask(task = {}) {
  const complexity = analyzeTaskComplexity(task);

  return createTaskAnalysis(complexity, []);
}

function createTaskAnalysis(complexity, assignments = []) {
  return {
    level: complexity.level,
    wantsImplementation: complexity.wantsImplementation,
    requiresSplit: complexity.requiresSplit,
    signals: {
      frontend: complexity.frontendSignals,
      backend: complexity.backendSignals,
      complexity: complexity.complexitySignals
    },
    recommendedExpertCount: assignments.length,
    selectedExpertIds: assignments.map((assignment) => assignment.expert.id)
  };
}

function createContextPolicy(task, assignments, complexity) {
  const text = String(task ?? "");

  return {
    strategy: complexity.level === "complex" ? "scoped_parallel" : "focused_single_pass",
    includeSharedTask: true,
    isolateExpertMemory: true,
    preserveLatestUserInstruction: true,
    expectedInputs: [
      "latest_user_task",
      complexity.requiresSplit ? "workspace_boundaries" : null,
      text.length > 120 ? "task_summary" : null
    ].filter(Boolean),
    perExpertScopes: assignments.map((assignment) => ({
      assignmentId: assignment.id,
      expertId: assignment.expert.id,
      includeFullTask: true,
      includeOtherExpertPrivateMemory: false
    }))
  };
}

function createExecutionHints(assignments, complexity) {
  const canRunInParallel = assignments.length > 1;

  return {
    mode: canRunInParallel ? "parallel" : "single",
    waitForAll: canRunInParallel,
    coordinatorShouldMerge: canRunInParallel,
    verifyAfterMerge: complexity.wantsImplementation,
    maxParallelExperts: assignments.length
  };
}

function createOutputPolicy(complexity) {
  return {
    compressToolOutputs: true,
    preferFindingsFirst: true,
    includeValidation: complexity.wantsImplementation,
    summaryDetail: complexity.level === "complex" ? "structured" : "concise"
  };
}

/**
 * 按任务相关性给专家排序。
 *
 * @param {string} task - 用户任务。
 * @param {object[]} profiles - 专家档案。
 * @returns {object[]} 排序后的专家。
 */
function rankExpertProfiles(task, profiles, complexity = analyzeTaskComplexity(task)) {
  const scored = profiles
    .map((profile) => ({
      profile,
      score: scoreProfileForPlanning(profile, task, complexity)
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.profile.id.localeCompare(right.profile.id);
    });

  return scored.map((entry) => entry.profile);
}

/**
 * 让常见开发任务至少包含架构/测试覆盖。
 *
 * @param {object[]} selected - 已选择专家。
 * @param {string} task - 用户任务。
 * @param {object[]} profiles - 专家档案。
 * @param {number} limit - 最大专家数量。
 * @returns {object[]} 完整专家列表。
 */
function ensureCoordinatorCoverage(selected, task, profiles, limit, complexity = analyzeTaskComplexity(task)) {
  const result = [...selected];
  const text = task.toLowerCase();
  const wantsImplementation = /写|实现|修改|生成|build|create|implement|html|vue|代码|网页/u.test(text);
  const recommended = recommendedCoverageExperts(complexity, wantsImplementation, text);

  for (const expertId of recommended) {
    if (result.length >= limit) {
      break;
    }

    const profile = getExpertProfile(expertId, profiles);

    if (profile && !result.some((entry) => entry.id === profile.id)) {
      result.push(profile);
    }
  }

  return result;
}

/**
 * 创建单个专家任务。
 *
 * @param {object} expert - 专家档案。
 * @param {object} options - 任务上下文。
 * @returns {object} 专家任务。
 */
function createExpertAssignment(expert, options = {}) {
  const task = String(options.task ?? "");
  const focus = assignmentFocus(expert.id);

  return {
    id: `expert_${options.index + 1}_${expert.id}`,
    expert: {
      id: expert.id,
      name: expert.name,
      role: expert.role
    },
    expertProfile: {
      id: expert.id,
      name: expert.name,
      role: expert.role,
      description: expert.description,
      instructions: expert.instructions ?? [],
      keywords: expert.keywords ?? [],
      dynamic: Boolean(expert.dynamic),
      prompt: expert.prompt ?? ""
    },
    task: `${focus}\n\n原始任务：${task}`,
    context: [
      `你是 ${expert.name}。只从自己的专业角度分析，输出发现、建议和验证点，不要直接替其他专家下结论。`,
      "你有自己的专家私有记忆，只能使用自己的私有记忆和共享项目记忆。",
      "如果遇到信息不足或冲突，先把问题写给技术 Leader，不要直接问用户。",
      "不要和其他子专家通信，也不要读取或依赖其他专家的私有记忆。"
    ].join("\n")
  };
}

/**
 * 根据专家 id 返回任务聚焦说明。
 *
 * @param {string} expertId - 专家 id。
 * @returns {string} 聚焦说明。
 */
function assignmentFocus(expertId) {
  const focuses = {
    fullstack: "请从端到端交付角度审视需求，优先给出简单可落地实现，覆盖前端、后端/数据流、文件结构和启动验证。",
    backend: "请审视 API、服务端业务逻辑、数据模型、鉴权、错误处理、持久化和前后端契约。",
    frontend: "请审视页面结构、交互、视觉一致性、响应式布局和用户体验。",
    architect: "请审视模块边界、文件结构、实现路径、维护成本和扩展风险。",
    tester: "请设计最小有效验证方案，指出边界条件、回归风险和手动冒烟步骤。",
    security: "请审视权限、沙箱、命令执行、敏感信息和外部资源风险。",
    performance: "请审视性能瓶颈、资源加载、缓存、阻塞流程和可测量指标。",
    memory: "请审视记忆保存、召回、去噪、scope 隔离和 prompt 注入风险。",
    tools: "请审视工具 schema、handler、runtime 路由、错误返回和 tool result 回灌。",
    general: "请做综合分析，找出最直接的实现路径和明显风险。"
  };

  return focuses[expertId] ?? "请从你的动态专家角色出发，聚焦该领域的关键判断、风险、建议和验证点。";
}

/**
 * 生成计划策略描述。
 *
 * @param {string} task - 用户任务。
 * @param {object[]} assignments - 专家任务列表。
 * @returns {string} 策略描述。
 */
function createPlanStrategy(task, assignments) {
  return [
    `先并行派出 ${assignments.length} 个专家。`,
    "等待所有专家完成后，只采用和原始任务直接相关的建议。",
    "最后由主 agent 负责执行、验证和汇总，避免专家之间互相覆盖最新用户指令。"
  ].join("");
}

/**
 * 生成汇总提示。
 *
 * @param {string} task - 用户任务。
 * @param {object[]} assignments - 专家任务列表。
 * @returns {string} 汇总提示。
 */
function createSummaryPrompt(task, assignments) {
  const names = assignments.map((assignment) => assignment.expert.name).join("、");

  return `综合 ${names} 的结果完成原始任务：“${task}”。最终只输出中文摘要、文件路径和验证结果。`;
}

/**
 * 计算专家规划分数。
 *
 * @param {object} profile - 专家档案。
 * @param {string} task - 用户任务。
 * @returns {number} 分数。
 */
function scoreProfileForPlanning(profile, task, complexity = analyzeTaskComplexity(task)) {
  const text = String(task ?? "").toLowerCase();
  let score = 0;

  if (profile.id === "fullstack" && complexity.requiresSplit) {
    return 0;
  }

  for (const keyword of profile.keywords ?? []) {
    const normalized = String(keyword).toLowerCase();

    if (normalized && text.includes(normalized)) {
      score += normalized.length > 2 ? 4 : 1;
    }
  }

  if (profile.id === "frontend" && /html|css|网页|页面|官网|ui|vue/u.test(text)) {
    score += 6;
  }

  if (profile.id === "fullstack") {
    if (complexity.level === "simple" && complexity.wantsImplementation) {
      score += 10;
    }

    if (/全栈|端到端|app|website|官网|网页|vue|html|项目/u.test(text)) {
      score += 5;
    }

    if (complexity.level === "complex" || complexity.requiresSplit) {
      score -= 6;
    }
  }

  if (profile.id === "backend" && /api|接口|后端|服务端|server|database|数据库|auth|登录|鉴权|持久化/u.test(text)) {
    score += 7;
  }

  if (profile.id === "frontend" && complexity.requiresSplit) {
    score += 4;
  }

  if (profile.id === "backend" && complexity.requiresSplit) {
    score += 4;
  }

  if (profile.id === "tools" && /工具|tool|handler|runtime|调用/u.test(text)) {
    score += 6;
  }

  if (profile.id === "memory" && /记忆|memory|recall|remember|prompt/u.test(text)) {
    score += 6;
  }

  return score;
}

/**
 * 判断任务复杂度，用于决定优先派全栈还是拆前后端专家。
 *
 * @param {string} task - 用户任务。
 * @returns {object} 复杂度分析结果。
 */
function analyzeTaskComplexity(task) {
  const text = String(task ?? "").toLowerCase();
  const wantsImplementation = /写|实现|修改|生成|build|create|implement|html|vue|代码|网页|项目|app/u.test(text);
  const frontendSignals = /前端|页面|ui|ux|vue|react|html|css|组件|交互|官网|网页/u.test(text);
  const backendSignals = /后端|服务端|api|接口|database|数据库|db|auth|登录|鉴权|持久化|server|node|express/u.test(text);
  const complexitySignals = [
    /复杂|大型|完整|生产级|企业级|多模块|架构|重构|权限|支付|订单|数据库|鉴权|部署|并发|缓存|队列|微服务/u,
    /complex|large|production|enterprise|architecture|refactor|payment|database|deploy|queue|microservice/u
  ].filter((pattern) => pattern.test(text)).length;
  const requiresSplit = frontendSignals && backendSignals;
  const level = requiresSplit || complexitySignals > 0 || text.length > 120
    ? "complex"
    : "simple";

  return {
    level,
    wantsImplementation,
    frontendSignals,
    backendSignals,
    requiresSplit,
    complexitySignals
  };
}

/**
 * 选择自动规划时的第一批核心专家。
 *
 * @param {object} complexity - 复杂度分析结果。
 * @returns {string[]} 推荐专家 id。
 */
function recommendedPrimaryExperts(complexity) {
  if (!complexity.wantsImplementation) {
    return [];
  }

  if (complexity.level === "simple" && !complexity.requiresSplit) {
    return ["fullstack"];
  }

  if (complexity.requiresSplit) {
    return ["frontend", "backend"];
  }

  if (complexity.backendSignals) {
    return ["backend"];
  }

  if (complexity.frontendSignals) {
    return ["frontend"];
  }

  return ["fullstack"];
}

/**
 * 给规划补充必要覆盖专家。
 *
 * @param {object} complexity - 复杂度分析结果。
 * @param {boolean} wantsImplementation - 是否是实现类任务。
 * @param {string} text - 小写任务文本。
 * @returns {string[]} 推荐补充专家 id。
 */
function recommendedCoverageExperts(complexity, wantsImplementation, text) {
  if (!wantsImplementation) {
    return ["general"];
  }

  if (complexity.level === "simple" && !complexity.requiresSplit) {
    return /测试|test|验证|回归/u.test(text) ? ["tester"] : [];
  }

  return ["architect", "tester"];
}

/**
 * 标准化专家 id 列表。
 *
 * @param {unknown} value - 原始值。
 * @returns {string[]} 专家 id 列表。
 */
function normalizeExpertIds(value) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean);
}

/**
 * 标准化技术 Leader 动态创建的专家。
 *
 * @param {unknown} value - 原始动态专家数组。
 * @returns {object[]} 动态专家档案。
 */
function normalizeCustomExperts(value) {
  return normalizeExpertProfiles(value).map((profile) => ({
    ...profile,
    dynamic: true
  }));
}

/**
 * 标准化专家数量限制。
 *
 * @param {unknown} value - 原始数量。
 * @returns {number} 数量限制。
 */
function normalizePlanLimit(value) {
  const number = Number(value);

  if (!Number.isSafeInteger(number) || number <= 0) {
    return DEFAULT_EXPERT_PLAN_LIMIT;
  }

  return Math.min(number, 8);
}
