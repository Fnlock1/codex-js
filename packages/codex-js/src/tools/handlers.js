import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  createApplyPatchApplyFromText,
  createApplyPatchDryRunFromText,
  createApplyPatchPlanFromText
} from "../apply-patch/runtime.js";
import {
  APPROVAL_ACTIONS,
  APPROVAL_DECISIONS,
  APPROVAL_RESOURCE_TYPES
} from "../approval/policy.js";
import { ExecRunner } from "../exec/runner.js";
import {
  createPermissionsApprovalServerRequest
} from "../app-server/server-requests.js";
import {
  normalizeGrantedPermissionProfile
} from "../app-server/permissions.js";
import {
  createThreadGoal,
  normalizeThreadGoal
} from "../app-server/thread-goal.js";
import {
  AgentCoordinator
} from "../agents/coordinator.js";
import {
  CommandSessionManager,
  commandSessionResultToText
} from "../exec/session.js";
import {
  SANDBOX_DECISIONS
} from "../sandbox/policy.js";
import {
  BUILTIN_TOOL_NAMES,
  TOOL_CALL_RESULT_STATUSES,
  commandFromToolArguments,
  createApplyPatchApprovalGateRequest,
  createRequestPermissionsApprovalGateRequest,
  createToolCallResult,
  patchFromToolArguments
} from "./runtime.js";

export class ShellCommandToolHandler {
  constructor(options = {}) {
    this.execRunner = options.execRunner ?? new ExecRunner({
      workingDirectory: options.workingDirectory,
      approvalGate: options.approvalGate,
      sandboxPolicy: options.sandboxPolicy
    });
    this.realExecution = Boolean(options.realExecution ?? false);
    this.approvalGate = options.approvalGate ?? null;
  }

  async run(request, context = {}) {
    const command = commandFromToolArguments(request.arguments);
    const approvalGate = this.approvalGate ?? context.approvalGate ?? null;

    if (this.realExecution && approvalGate) {
      const approval = await approvalGate.check(createToolApprovalGateRequest(request.name, {
        metadata: {
          arguments: request.arguments,
          command,
          cwd: request.arguments?.cwd ?? context.turnContext?.workingDirectory ?? null
        }
      }));

      if (approval.decision !== APPROVAL_DECISIONS.ALLOW) {
        return createToolCallResult({
          callId: request.call_id,
          name: request.name,
          status: TOOL_CALL_RESULT_STATUSES.FAILED,
          output: `shell command blocked: ${approval.decision}`,
          error: `blocked: ${approval.decision}`,
          raw: {
            dry_run: true,
            approval
          }
        });
      }
    }

    const iterator = this.realExecution
      ? this.execRunner.runCommand({
          command,
          cwd: request.arguments?.cwd,
          timeoutMs: request.arguments?.timeoutMs ?? request.arguments?.timeout_ms,
          env: request.arguments?.env
        })
      : this.execRunner.runDryCommand({
          command,
          cwd: request.arguments?.cwd,
          timeoutMs: request.arguments?.timeoutMs ?? request.arguments?.timeout_ms,
          env: request.arguments?.env
        });
    let next = await iterator.next();

    while (!next.done) {
      next = await iterator.next();
    }

    const result = next.value ?? null;
    const exitCode = result?.output?.exit_code;
    const failed = Boolean(result?.error) || (exitCode != null && exitCode !== 0);

    return createToolCallResult({
      callId: request.call_id,
      name: request.name,
      status: failed ? TOOL_CALL_RESULT_STATUSES.FAILED : TOOL_CALL_RESULT_STATUSES.COMPLETED,
      output: result?.output?.aggregated_output?.text ?? `dry-run: ${command}`,
      error: result?.error ?? (failed ? `exit_code:${exitCode}` : null),
      raw: {
        dry_run: result?.dry_run ?? true,
        real_execution: this.realExecution,
        exec: result
      }
    });
  }
}

export class ExecCommandToolHandler {
  constructor(options = {}) {
    this.commandSessionManager = options.commandSessionManager ?? new CommandSessionManager();
  }

  async run(request) {
    const result = this.commandSessionManager.start(request.arguments ?? {});

    return createToolCallResult({
      callId: request.call_id,
      name: request.name,
      status: result.error ? TOOL_CALL_RESULT_STATUSES.FAILED : TOOL_CALL_RESULT_STATUSES.COMPLETED,
      output: commandSessionResultToText(result),
      error: result.error ?? null,
      raw: {
        exec_command: result,
        dry_run: result.dry_run
      }
    });
  }
}

export class WriteStdinToolHandler {
  constructor(options = {}) {
    this.commandSessionManager = options.commandSessionManager ?? new CommandSessionManager();
  }

  async run(request) {
    const result = this.commandSessionManager.write(request.arguments ?? {});

    return createToolCallResult({
      callId: request.call_id,
      name: request.name,
      status: result.error ? TOOL_CALL_RESULT_STATUSES.FAILED : TOOL_CALL_RESULT_STATUSES.COMPLETED,
      output: commandSessionResultToText(result),
      error: result.error ?? null,
      raw: {
        write_stdin: result,
        dry_run: result.dry_run
      }
    });
  }
}

export class ApplyPatchToolHandler {
  constructor(options = {}) {
    this.allowApplyPatch = options.allowApplyPatch ?? false;
    this.allowApplyPatchWrites = options.allowApplyPatchWrites ?? false;
    this.applyPatchFileProvider = options.applyPatchFileProvider ?? null;
    this.applyPatchFsRuntime = options.applyPatchFsRuntime ?? null;
    this.approvalGate = options.approvalGate ?? null;
    this.sandboxPolicy = options.sandboxPolicy ?? null;
    this.workingDirectory = options.workingDirectory;
  }

  async run(request, context = {}) {
    const patch = patchFromToolArguments(request.arguments);
    const approvalGate = this.approvalGate ?? context.approvalGate ?? null;
    const workingDirectory = this.workingDirectory ?? context.turnContext?.workingDirectory;

    if (this.allowApplyPatchWrites && approvalGate) {
      const approval = await approvalGate.check(createApplyPatchApprovalGateRequest({
        patch,
        workingDirectory
      }));

      if (approval.decision !== APPROVAL_DECISIONS.ALLOW) {
        return createToolCallResult({
          callId: request.call_id,
          name: request.name,
          status: TOOL_CALL_RESULT_STATUSES.FAILED,
          output: `apply_patch blocked: ${approval.decision}`,
          error: `blocked: ${approval.decision}`,
          raw: {
            dry_run: true,
            approval
          }
        });
      }
    }

    const result = this.allowApplyPatchWrites
      ? await createApplyPatchApplyFromText(patch, {
          fileProvider: this.applyPatchFileProvider ?? context.applyPatchFileProvider,
          fsRuntime: this.applyPatchFsRuntime ?? context.applyPatchFsRuntime,
          workingDirectory,
          allowWrites: true,
          sandboxPolicy: this.sandboxPolicy ?? context.sandboxPolicy ?? null
        })
      : this.allowApplyPatch
        ? await createApplyPatchPlanFromText(patch, {
            fileProvider: this.applyPatchFileProvider ?? context.applyPatchFileProvider ?? {},
            workingDirectory,
            allowAbsolutePaths: false,
            sandboxPolicy: this.sandboxPolicy ?? context.sandboxPolicy ?? null
          })
        : createApplyPatchDryRunFromText(patch);

    return createToolCallResult({
      callId: request.call_id,
      name: request.name,
      status: result.status === "completed"
        ? TOOL_CALL_RESULT_STATUSES.COMPLETED
        : TOOL_CALL_RESULT_STATUSES.FAILED,
      output: result.output,
      error: result.error ?? null,
      raw: result.raw
    });
  }
}

export class RequestPermissionsToolHandler {
  constructor(options = {}) {
    this.serverRequestStore = options.serverRequestStore ?? null;
    this.permissionGrantStore = options.permissionGrantStore ?? null;
    this.approvalGate = options.approvalGate ?? null;
    this.workingDirectory = options.workingDirectory;
  }

  async run(request, context = {}) {
    const args = request.arguments && typeof request.arguments === "object"
      ? request.arguments
      : {};
    const approvalGate = this.approvalGate ?? context.approvalGate ?? null;
    const serverRequestStore = this.serverRequestStore ?? context.serverRequestStore ?? null;
    const permissionGrantStore = this.permissionGrantStore ?? context.permissionGrantStore ?? null;
    const threadId = context.turnContext?.threadId ?? context.threadId ?? "standalone";
    const turnId = context.turnId ?? context.turnContext?.metadata?.turnId ?? "standalone";
    const cwd = args.cwd ?? context.turnContext?.workingDirectory ?? this.workingDirectory ?? process.cwd();
    const metadata = {
      threadId,
      turnId,
      itemId: request.call_id,
      environmentId: args.environment_id ?? args.environmentId ?? null,
      cwd,
      reason: args.reason ?? null,
      permissions: args.permissions ?? {}
    };

    if (approvalGate) {
      const approval = await approvalGate.check(createRequestPermissionsApprovalGateRequest(metadata));

      if (approval.decision !== APPROVAL_DECISIONS.ALLOW) {
        const serverRequest = approval.decision === APPROVAL_DECISIONS.PROMPT && serverRequestStore
          ? serverRequestStore.create(createPermissionsApprovalServerRequest({
              approval,
              threadId,
              turnId,
              itemId: request.call_id,
              environmentId: metadata.environmentId,
              cwd,
              reason: metadata.reason,
              permissions: metadata.permissions
            }))
          : null;

        return createToolCallResult({
          callId: request.call_id,
          name: request.name,
          status: TOOL_CALL_RESULT_STATUSES.FAILED,
          output: approval.decision === APPROVAL_DECISIONS.PROMPT
            ? "permissions approval required"
            : "permissions request forbidden",
          error: approval.decision === APPROVAL_DECISIONS.PROMPT
            ? "approval_required"
            : "approval_forbidden",
          raw: {
            approval,
            requestId: serverRequest?.requestId ?? null,
            serverRequest: serverRequest
              ? {
                  requestId: serverRequest.requestId,
                  method: serverRequest.method,
                  params: serverRequest.params
                }
              : null
          }
        });
      }
    }

    const grant = permissionGrantStore
      ? permissionGrantStore.add({
          threadId,
          turnId,
          itemId: request.call_id,
          environmentId: metadata.environmentId,
          cwd,
          reason: metadata.reason,
          requested: metadata.permissions,
          granted: metadata.permissions,
          scope: "turn"
      })
      : null;
    const grantedPermissions = grant?.permissions ?? normalizeGrantedPermissionProfile(metadata.permissions);
    const sandboxUpdate = applyGrantedPermissionsToSandboxPolicy(
      context.sandboxPolicy,
      grantedPermissions
    );

    return createToolCallResult({
      callId: request.call_id,
      name: request.name,
      status: TOOL_CALL_RESULT_STATUSES.COMPLETED,
      output: "permissions request accepted for this turn. Continue with the originally requested filesystem or network tool; do not request the same permission again.",
      raw: {
        permissions: grantedPermissions,
        scope: grant?.scope ?? "turn",
        grant,
        sandbox: sandboxUpdate
      }
    });
  }
}

export function applyGrantedPermissionsToSandboxPolicy(sandboxPolicy, permissions = {}) {
  if (!sandboxPolicy) {
    return {
      applied: false,
      reason: "sandbox_policy_not_available"
    };
  }

  const granted = normalizeGrantedPermissionProfile(permissions);
  const readRoots = granted.fileSystem?.read ?? [];
  const writeRoots = granted.fileSystem?.write ?? [];
  const applied = {
    readRoots: [],
    writeRoots: [],
    networkAllowed: false
  };

  for (const root of readRoots) {
    const normalized = normalizeSandboxGrantPath(root, sandboxPolicy.workingDirectory);

    if (!sandboxPolicy.readRoots.includes(normalized)) {
      sandboxPolicy.readRoots.push(normalized);
      applied.readRoots.push(normalized);
    }
  }

  for (const root of writeRoots) {
    const normalized = normalizeSandboxGrantPath(root, sandboxPolicy.workingDirectory);

    if (!sandboxPolicy.writeRoots.includes(normalized)) {
      sandboxPolicy.writeRoots.push(normalized);
      applied.writeRoots.push(normalized);
    }

    if (!sandboxPolicy.readRoots.includes(normalized)) {
      sandboxPolicy.readRoots.push(normalized);
      applied.readRoots.push(normalized);
    }
  }

  if (granted.network?.enabled === true && sandboxPolicy.networkAllowed !== true) {
    sandboxPolicy.networkAllowed = true;
    applied.networkAllowed = true;
  }

  return {
    applied: true,
    ...applied
  };
}

function normalizeSandboxGrantPath(root, workingDirectory) {
  const value = String(root ?? "");

  if (!value) {
    return path.resolve(workingDirectory ?? process.cwd());
  }

  return path.resolve(
    path.isAbsolute(value)
      ? value
      : path.join(workingDirectory ?? process.cwd(), value)
  );
}

export class ViewImageToolHandler {
  constructor(options = {}) {
    this.sandboxPolicy = options.sandboxPolicy ?? null;
    this.workingDirectory = options.workingDirectory;
    this.maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  }

  async run(request, context = {}) {
    const args = request.arguments && typeof request.arguments === "object"
      ? request.arguments
      : {};
    const targetPath = path.resolve(
      this.workingDirectory ?? context.turnContext?.workingDirectory ?? process.cwd(),
      String(args.path ?? "")
    );
    const sandboxPolicy = this.sandboxPolicy ?? context.sandboxPolicy ?? null;

    if (!args.path) {
      return createToolCallResult({
        callId: request.call_id,
        name: request.name,
        status: TOOL_CALL_RESULT_STATUSES.FAILED,
        output: "view_image requires a path.",
        error: "missing_path"
      });
    }

    if (sandboxPolicy) {
      const decision = sandboxPolicy.checkRead(targetPath);

      if (decision.decision !== SANDBOX_DECISIONS.ALLOW) {
        return createToolCallResult({
          callId: request.call_id,
          name: request.name,
          status: TOOL_CALL_RESULT_STATUSES.FAILED,
          output: `view_image sandbox blocked: ${decision.reason}`,
          error: "sandbox_denied",
          raw: {
            sandbox: decision
          }
        });
      }
    }

    try {
      const bytes = await readFile(targetPath);

      if (bytes.byteLength > this.maxBytes) {
        return createToolCallResult({
          callId: request.call_id,
          name: request.name,
          status: TOOL_CALL_RESULT_STATUSES.FAILED,
          output: `image is too large: ${bytes.byteLength} bytes`,
          error: "image_too_large",
          raw: {
            path: targetPath,
            max_bytes: this.maxBytes
          }
        });
      }

      const detail = args.detail === "original" ? "original" : "high";
      const imageUrl = `data:${mimeTypeForImagePath(targetPath)};base64,${bytes.toString("base64")}`;
      const payload = {
        image_url: imageUrl,
        detail,
        path: targetPath,
        bytes: bytes.byteLength
      };

      return createToolCallResult({
        callId: request.call_id,
        name: request.name,
        output: JSON.stringify(payload),
        raw: {
          view_image: payload
        }
      });
    } catch (error) {
      return createToolCallResult({
        callId: request.call_id,
        name: request.name,
        status: TOOL_CALL_RESULT_STATUSES.FAILED,
        output: error.message,
        error: error.code ?? "read_image_failed",
        raw: {
          path: targetPath
        }
      });
    }
  }
}

export class ToolSearchToolHandler {
  constructor(options = {}) {
    this.getTools = options.getTools ?? null;
  }

  async run(request, context = {}) {
    const args = request.arguments && typeof request.arguments === "object"
      ? request.arguments
      : {};
    const query = String(args.query ?? "").trim().toLowerCase();
    const limit = normalizePositiveLimit(args.limit, 8);
    const tools = this.getTools
      ? this.getTools()
      : context.router?.list?.() ?? [];

    if (!query) {
      return createToolCallResult({
        callId: request.call_id,
        name: request.name,
        status: TOOL_CALL_RESULT_STATUSES.FAILED,
        output: "tool_search requires a query.",
        error: "missing_query"
      });
    }

    const matches = tools
      .map((entry) => ({
        entry,
        score: scoreToolSearchMatch(entry, query)
      }))
      .filter((match) => match.score > 0)
      .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
      .slice(0, limit)
      .map(({ entry }) => ({
        name: entry.name,
        spec: entry.spec,
        metadata: entry.metadata ?? null
      }));

    return createToolCallResult({
      callId: request.call_id,
      name: request.name,
      output: JSON.stringify({
        query,
        matches
      }),
      raw: {
        tool_search: {
          query,
          matches
        }
      }
    });
  }
}

export class SpawnAgentToolHandler {
  constructor(options = {}) {
    this.agentCoordinator = options.agentCoordinator ?? new AgentCoordinator();
  }

  async run(request, context = {}) {
    const args = request.arguments && typeof request.arguments === "object"
      ? request.arguments
      : {};
    const task = String(args.task ?? "").trim();

    if (!task) {
      return createToolCallResult({
        callId: request.call_id,
        name: request.name,
        status: TOOL_CALL_RESULT_STATUSES.FAILED,
        output: "spawn_agent requires a task.",
        error: "missing_task"
      });
    }

    const agent = await this.agentCoordinator.spawn({
      name: args.name,
      role: args.role,
      task,
      parentAgentId: args.parent_agent_id ?? args.parentAgentId ?? null,
      threadId: context.turnContext?.threadId ?? context.threadId ?? null,
      metadata: {
        context: args.context ?? null,
        created_by_tool_call: request.call_id
      },
      autostart: args.autostart ?? Boolean(this.agentCoordinator.runner)
    });

    return createToolCallResult({
      callId: request.call_id,
      name: request.name,
      output: JSON.stringify({
        agent_id: agent.id,
        status: agent.status,
        task: agent.task
      }),
      raw: {
        agent
      }
    });
  }
}

export class WaitAgentToolHandler {
  constructor(options = {}) {
    this.agentCoordinator = options.agentCoordinator ?? new AgentCoordinator();
  }

  async run(request) {
    const args = request.arguments && typeof request.arguments === "object"
      ? request.arguments
      : {};
    const agentId = String(args.agent_id ?? args.agentId ?? "").trim();

    if (!agentId) {
      return createToolCallResult({
        callId: request.call_id,
        name: request.name,
        status: TOOL_CALL_RESULT_STATUSES.FAILED,
        output: "wait_agent requires an agent_id.",
        error: "missing_agent_id"
      });
    }

    const agent = await this.agentCoordinator.wait(agentId, {
      timeoutMs: args.timeout_ms ?? args.timeoutMs
    });

    if (!agent) {
      return createToolCallResult({
        callId: request.call_id,
        name: request.name,
        status: TOOL_CALL_RESULT_STATUSES.FAILED,
        output: `agent not found: ${agentId}`,
        error: "agent_not_found"
      });
    }

    return createToolCallResult({
      callId: request.call_id,
      name: request.name,
      output: JSON.stringify({
        agent_id: agent.id,
        status: agent.status,
        result: agent.result,
        error: agent.error,
        timed_out: agent.status === "running"
      }),
      raw: {
        agent
      }
    });
  }
}

export class GoalToolHandler {
  constructor(options = {}) {
    this.goalStore = options.goalStore ?? new InMemoryGoalStore();
    this.kind = options.kind ?? BUILTIN_TOOL_NAMES.GET_GOAL;
  }

  async run(request, context = {}) {
    const threadId = context.turnContext?.threadId ?? context.threadId ?? "standalone";
    const args = request.arguments && typeof request.arguments === "object"
      ? request.arguments
      : {};

    try {
      if (this.kind === BUILTIN_TOOL_NAMES.CREATE_GOAL) {
        const goal = this.goalStore.set(threadId, createThreadGoal({
          threadId,
          objective: args.objective,
          status: args.status,
          tokenBudget: args.token_budget ?? args.tokenBudget
        }));

        return createToolCallResult({
          callId: request.call_id,
          name: request.name,
          output: JSON.stringify({
            goal
          }),
          raw: {
            goal
          }
        });
      }

      if (this.kind === BUILTIN_TOOL_NAMES.UPDATE_GOAL) {
        const existing = this.goalStore.get(threadId);

        if (!existing && !args.objective) {
          return createToolCallResult({
            callId: request.call_id,
            name: request.name,
            status: TOOL_CALL_RESULT_STATUSES.FAILED,
            output: "update_goal requires an existing goal or a new objective.",
            error: "missing_goal"
          });
        }

        const goal = this.goalStore.set(threadId, createThreadGoal({
          threadId,
          objective: args.objective ?? existing?.objective,
          status: args.status ?? existing?.status,
          tokenBudget: args.token_budget ?? args.tokenBudget ?? existing?.tokenBudget,
          tokensUsed: args.tokens_used ?? args.tokensUsed ?? existing?.tokensUsed,
          timeUsedSeconds: args.time_used_seconds ?? args.timeUsedSeconds ?? existing?.timeUsedSeconds,
          existing
        }));

        return createToolCallResult({
          callId: request.call_id,
          name: request.name,
          output: JSON.stringify({
            goal
          }),
          raw: {
            goal
          }
        });
      }

      const goal = normalizeThreadGoal(this.goalStore.get(threadId), {
        threadId
      });

      return createToolCallResult({
        callId: request.call_id,
        name: request.name,
        output: JSON.stringify({
          goal
        }),
        raw: {
          goal
        }
      });
    } catch (error) {
      return createToolCallResult({
        callId: request.call_id,
        name: request.name,
        status: TOOL_CALL_RESULT_STATUSES.FAILED,
        output: error.message,
        error: error.code ?? "goal_error"
      });
    }
  }
}

export class HostedProviderToolHandler {
  constructor(options = {}) {
    this.provider = options.provider ?? null;
    this.kind = options.kind ?? "hosted";
  }

  async run(request, context = {}) {
    if (!this.provider) {
      return createToolCallResult({
        callId: request.call_id,
        name: request.name,
        status: TOOL_CALL_RESULT_STATUSES.FAILED,
        output: `${request.name} provider is not configured.`,
        error: "provider_not_configured",
        raw: {
          hosted: {
            kind: this.kind,
            safe_placeholder: true
          }
        }
      });
    }

    const sandboxPolicy = context.sandboxPolicy ?? null;

    if (sandboxPolicy) {
      const decision = sandboxPolicy.checkNetwork();

      if (decision.decision !== SANDBOX_DECISIONS.ALLOW) {
        return createToolCallResult({
          callId: request.call_id,
          name: request.name,
          status: TOOL_CALL_RESULT_STATUSES.FAILED,
          output: `${request.name} sandbox blocked: ${decision.reason}`,
          error: "sandbox_denied",
          raw: {
            sandbox: decision
          }
        });
      }
    }

    try {
      const payload = typeof this.provider === "function"
        ? await this.provider(request.arguments ?? {}, {
            request,
            context,
            kind: this.kind
          })
        : await this.provider.run(request.arguments ?? {}, {
            request,
            context,
            kind: this.kind
          });

      return createToolCallResult({
        callId: request.call_id,
        name: request.name,
        output: typeof payload === "string" ? payload : JSON.stringify(payload ?? {}),
        raw: {
          hosted: {
            kind: this.kind,
            payload
          }
        }
      });
    } catch (error) {
      return createToolCallResult({
        callId: request.call_id,
        name: request.name,
        status: TOOL_CALL_RESULT_STATUSES.FAILED,
        output: error.message,
        error: error.code ?? `${this.kind}_error`
      });
    }
  }
}

export class PlaceholderToolHandler {
  constructor(options = {}) {
    this.error = options.error ?? "not_implemented";
    this.reason = options.reason ?? "safe_placeholder";
  }

  async run(request) {
    return createToolCallResult({
      callId: request.call_id,
      name: request.name,
      status: TOOL_CALL_RESULT_STATUSES.FAILED,
      output: `tool execution is not implemented: ${request.name}`,
      error: this.error,
      raw: {
        reason: this.reason,
        safe_placeholder: true
      }
    });
  }
}

export class McpResourceToolHandler {
  constructor(options = {}) {
    this.mcpRuntime = options.mcpRuntime ?? null;
    this.kind = options.kind ?? "list_resources";
  }

  async run(request) {
    if (!this.mcpRuntime) {
      return createToolCallResult({
        callId: request.call_id,
        name: request.name,
        status: TOOL_CALL_RESULT_STATUSES.FAILED,
        output: "MCP runtime is not connected.",
        error: "mcp_not_connected",
        raw: {
          safe_placeholder: true,
          mcp: {
            kind: this.kind
          }
        }
      });
    }

    try {
      const payload = await this.callRuntime(request.arguments ?? {});

      return createToolCallResult({
        callId: request.call_id,
        name: request.name,
        status: TOOL_CALL_RESULT_STATUSES.COMPLETED,
        output: JSON.stringify(payload),
        raw: {
          mcp: payload
        }
      });
    } catch (error) {
      return createToolCallResult({
        callId: request.call_id,
        name: request.name,
        status: TOOL_CALL_RESULT_STATUSES.FAILED,
        output: error.message,
        error: error.code ?? "mcp_error",
        raw: {
          mcp: {
            kind: this.kind
          }
        }
      });
    }
  }

  async callRuntime(args) {
    if (this.kind === "list_resource_templates") {
      return await this.mcpRuntime.listResourceTemplates(args);
    }

    if (this.kind === "read_resource") {
      return await this.mcpRuntime.readResource(args);
    }

    return await this.mcpRuntime.listResources(args);
  }
}

export function createToolApprovalGateRequest(toolName, options = {}) {
  return {
    resourceType: APPROVAL_RESOURCE_TYPES.TOOL,
    action: APPROVAL_ACTIONS.RUN,
    subject: String(toolName ?? ""),
    description: `Run tool: ${toolName}`,
    metadata: options.metadata ?? {}
  };
}

export class InMemoryGoalStore {
  constructor(options = {}) {
    this.goals = new Map(Object.entries(options.goals ?? {}));
  }

  get(threadId) {
    return this.goals.get(String(threadId ?? "")) ?? null;
  }

  set(threadId, goal) {
    this.goals.set(String(threadId ?? ""), goal);
    return goal;
  }
}

function mimeTypeForImagePath(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".bmp":
      return "image/bmp";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function normalizePositiveLimit(value, fallback) {
  const number = Number(value);

  if (!Number.isSafeInteger(number) || number <= 0) {
    return fallback;
  }

  return Math.min(number, 50);
}

function scoreToolSearchMatch(entry, query) {
  const spec = entry.spec ?? {};
  const metadata = entry.metadata ?? {};
  const haystack = [
    entry.name,
    spec.name,
    spec.description,
    metadata.category,
    metadata.exposure
  ].filter(Boolean).join(" ").toLowerCase();

  if (!haystack.includes(query)) {
    return 0;
  }

  if (String(entry.name ?? "").toLowerCase() === query) {
    return 100;
  }

  if (String(entry.name ?? "").toLowerCase().includes(query)) {
    return 50;
  }

  return 10;
}
