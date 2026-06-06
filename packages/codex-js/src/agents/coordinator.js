import { randomUUID } from "node:crypto";

export const AGENT_STATUSES = Object.freeze({
  CREATED: "created",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled"
});

export class AgentCoordinator {
  constructor(options = {}) {
    this.agents = new Map();
    this.defaultRuntime = options.defaultRuntime ?? null;
    this.runner = options.runner ?? null;
    this.pollIntervalMs = options.pollIntervalMs ?? 25;
  }

  createAgent(options = {}) {
    const agent = createAgentRecord(options);

    this.agents.set(agent.id, agent);
    return agent;
  }

  getAgent(agentId) {
    return this.agents.get(String(agentId ?? "")) ?? null;
  }

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

  async complete(agentId, result = {}) {
    return this.updateAgent(agentId, {
      status: AGENT_STATUSES.COMPLETED,
      result
    });
  }

  async fail(agentId, error) {
    return this.updateAgent(agentId, {
      status: AGENT_STATUSES.FAILED,
      error: normalizeAgentError(error)
    });
  }

  async cancel(agentId, reason = "cancelled") {
    return this.updateAgent(agentId, {
      status: AGENT_STATUSES.CANCELLED,
      error: {
        message: String(reason)
      }
    });
  }

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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
