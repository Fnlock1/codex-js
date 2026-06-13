/**
 * 中文模块说明：src/agents/coordinator.js
 *
 * 本地子 agent 记录、启动、等待和状态管理。
 */
import { randomUUID } from "node:crypto";

export const AGENT_STATUSES = Object.freeze({
  CREATED: "created",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled"
});

/**
 * 定义 AgentCoordinator 类，封装当前模块的状态和行为。
 */
export class AgentCoordinator {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} options - options 参数。
   */
  constructor(options = {}) {
    this.agents = new Map();
    this.defaultRuntime = options.defaultRuntime ?? null;
    this.runner = options.runner ?? null;
    this.pollIntervalMs = options.pollIntervalMs ?? 25;
  }

  /**
   * 创建 create agent 相关数据。
   *
   * @param {unknown} options - options 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  createAgent(options = {}) {
    const agent = createAgentRecord(options);

    this.agents.set(agent.id, agent);
    return agent;
  }

  /**
   * 获取 get agent 相关数据。
   *
   * @param {unknown} agentId - agentId 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  getAgent(agentId) {
    return this.agents.get(String(agentId ?? "")) ?? null;
  }

  /**
   * 列出 list agents 相关数据。
   *
   * @param {unknown} options - options 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  listAgents(options = {}) {
    return Array.from(this.agents.values()).filter((agent) => {
      if (options.parentAgentId && agent.parentAgentId !== options.parentAgentId) {
        return false;
      }

      if (options.threadId && agent.threadId !== options.threadId) {
        return false;
      }

      return true;
    });
  }

  /**
   * 处理 update agent 相关逻辑。
   *
   * @param {unknown} agentId - agentId 参数。
   * @param {unknown} patch - patch 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  updateAgent(agentId, patch = {}) {
    const existing = this.getAgent(agentId);

    if (!existing) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const updated = {
      ...existing,
      ...patch,
      metadata: {
        ...existing.metadata,
        ...(patch.metadata ?? {})
      },
      updatedAt: new Date().toISOString()
    };

    this.agents.set(updated.id, updated);
    return updated;
  }

  /**
   * 处理 spawn 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} options - options 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async spawn(options = {}) {
    const agent = this.createAgent({
      ...options,
      status: AGENT_STATUSES.CREATED
    });

    if (!options.autostart) {
      return agent;
    }

    return await this.start(agent.id, options);
  }

  /**
   * 启动 start 相关数据。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} agentId - agentId 参数。
   * @param {unknown} options - options 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async start(agentId, options = {}) {
    const agent = this.updateAgent(agentId, {
      status: AGENT_STATUSES.RUNNING
    });
    const runner = options.runner ?? this.runner;

    if (!runner) {
      return agent;
    }

    const promise = Promise.resolve()
      .then(() => runner(agent, options))
      .then((result) => this.complete(agent.id, result))
      .catch((error) => this.fail(agent.id, error));

    this.updateAgent(agent.id, {
      metadata: {
        promise
      }
    });

    return this.getAgent(agent.id);
  }

  /**
   * 完成 complete 相关数据。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} agentId - agentId 参数。
   * @param {unknown} result - result 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async complete(agentId, result = {}) {
    return this.updateAgent(agentId, {
      status: AGENT_STATUSES.COMPLETED,
      result
    });
  }

  /**
   * 标记失败 fail 相关数据。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} agentId - agentId 参数。
   * @param {unknown} error - error 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async fail(agentId, error) {
    return this.updateAgent(agentId, {
      status: AGENT_STATUSES.FAILED,
      error: normalizeAgentError(error)
    });
  }

  /**
   * 取消 cancel 相关数据。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} agentId - agentId 参数。
   * @param {unknown} reason - reason 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async cancel(agentId, reason = "cancelled") {
    return this.updateAgent(agentId, {
      status: AGENT_STATUSES.CANCELLED,
      error: {
        message: String(reason)
      }
    });
  }

  /**
   * 等待 wait 相关数据。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} agentId - agentId 参数。
   * @param {unknown} options - options 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async wait(agentId, options = {}) {
    const timeoutMs = normalizeNonNegativeInteger(options.timeoutMs ?? options.timeout_ms, 30_000);
    const startedAt = Date.now();

    while (true) {
      const agent = this.getAgent(agentId);

      if (!agent) {
        throw new Error(`Agent not found: ${agentId}`);
      }

      if (terminalAgentStatuses.has(agent.status)) {
        return agent;
      }

      const promise = agent.metadata?.promise;

      if (!promise && agent.status === AGENT_STATUSES.CREATED) {
        return agent;
      }

      if (promise && typeof promise.then === "function") {
        await Promise.race([
          promise.catch(() => null),
          delay(this.pollIntervalMs)
        ]);
      } else {
        await delay(this.pollIntervalMs);
      }

      if (timeoutMs != null && Date.now() - startedAt >= timeoutMs) {
        return this.getAgent(agentId);
      }
    }
  }
}

/**
 * 创建 create agent record 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createAgentRecord(options = {}) {
  const now = new Date().toISOString();

  return {
    id: String(options.id ?? `agent_${randomUUID()}`),
    name: options.name == null ? null : String(options.name),
    role: options.role == null ? null : String(options.role),
    task: String(options.task ?? ""),
    parentAgentId: options.parentAgentId ?? options.parent_agent_id ?? null,
    threadId: options.threadId ?? options.thread_id ?? null,
    status: options.status ?? AGENT_STATUSES.CREATED,
    createdAt: options.createdAt ?? now,
    updatedAt: options.updatedAt ?? now,
    result: options.result ?? null,
    error: options.error ?? null,
    metadata: options.metadata ?? {}
  };
}

/**
 * 归一化 normalize agent error 相关数据。
 *
 * @param {unknown} error - error 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeAgentError(error) {
  if (error?.message) {
    return {
      message: String(error.message)
    };
  }

  return {
    message: String(error ?? "agent failed")
  };
}

const terminalAgentStatuses = new Set([
  AGENT_STATUSES.COMPLETED,
  AGENT_STATUSES.FAILED,
  AGENT_STATUSES.CANCELLED
]);

/**
 * 处理 delay 相关逻辑。
 *
 * @param {unknown} ms - ms 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 归一化 normalize non negative integer 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @param {unknown} fallback - fallback 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function normalizeNonNegativeInteger(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }

  const number = Number(value);

  if (!Number.isSafeInteger(number) || number < 0) {
    return fallback;
  }

  return number;
}
