import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  NoopToolCallRuntime,
  SafeToolCallRuntime,
  APPROVAL_DECISIONS,
  ApprovalGate,
  ApprovalPolicy,
  ApplyPatchToolHandler,
  BUILTIN_TOOL_NAMES,
  GoalToolHandler,
  HostedProviderToolHandler,
  InMemoryGoalStore,
  PermissionGrantStore,
  PlaceholderToolHandler,
  ServerRequestStore,
  ShellCommandToolHandler,
  SpawnAgentToolHandler,
  TOOL_EXPOSURE,
  ToolSearchToolHandler,
  ToolRouter,
  ViewImageToolHandler,
  WaitAgentToolHandler,
  createBuiltinToolDefinitions,
  createApplyPatchToolSpec,
  createImageGenerationToolSpec,
  createShellCommandToolSpec,
  createToolApprovalGateRequest,
  createPermissionsResponseFromClientResult,
  createWebSearchToolSpec,
  intersectPermissionProfiles,
  TOOL_CALL_RESULT_STATUSES,
  TOOL_SPEC_TYPES,
  ToolCallRuntime,
  ToolRegistry,
  createToolCallResult,
  GitDiffToolHandler,
  GitStatusToolHandler,
  HttpHostedToolProvider,
  ListFilesToolHandler,
  ReadFileToolHandler,
  SandboxPolicy,
  SearchFilesToolHandler,
  UPSTREAM_TOOL_PAYLOAD_TYPES,
  UPSTREAM_TOOL_SPEC_TYPES,
  commandFromToolArguments,
  createCustomToolPayload,
  createFunctionToolPayload,
  createJsonToolOutput,
  createToolsJsonForResponsesApi,
  createToolSearchPayload,
  createToolCallRequest,
  createUpstreamToolDefinition,
  createUpstreamToolSpec,
  deferUpstreamToolDefinition,
  telemetryPreview,
  toolOutputCodeModeResult,
  toolOutputLogPreview,
  toolOutputPostToolUseInput,
  toolOutputPostToolUseResponse,
  toolOutputSuccessForLogging,
  toolOutputToResponseItem,
  toolPayloadLogPayload,
  upstreamToolSpecName,
  normalizeToolArguments,
  patchFromToolArguments
} from "../src/index.js";

test("ToolRegistry can register, list, and get tool specs", () => {
  const registry = new ToolRegistry();
  const entry = registry.register({
    name: "apply_patch",
    description: "Apply a patch.",
    parameters: {
      type: "object"
    }
  });

  assert.equal(entry.name, "apply_patch");
  assert.equal(entry.spec.type, TOOL_SPEC_TYPES.FUNCTION);
  assert.equal(registry.has("apply_patch"), true);
  assert.equal(registry.get("apply_patch").spec.description, "Apply a patch.");
  assert.deepEqual(registry.modelVisibleSpecs(), [
    {
      type: "function",
      name: "apply_patch",
      description: "Apply a patch.",
      strict: false,
      parameters: {
        type: "object"
      },
      output_schema: null
    }
  ]);
});

test("ToolRegistry rejects duplicate names", () => {
  const registry = new ToolRegistry({
    tools: [
      {
        name: "shell",
        description: "Shell command."
      }
    ]
  });

  assert.throws(
    () => registry.register({
      name: "shell"
    }),
    /already registered/
  );
});

test("built-in tool specs expose shell and apply_patch tools", () => {
  assert.equal(createShellCommandToolSpec().name, "shell_command");
  const applyPatchSpec = createApplyPatchToolSpec();

  assert.deepEqual(applyPatchSpec.parameters.required, ["patch"]);
  assert.equal(applyPatchSpec.parameters.properties.input, undefined);
  assert.equal(applyPatchSpec.parameters.additionalProperties, false);

  const definitions = createBuiltinToolDefinitions({
    shellCommandHandler: new PlaceholderToolHandler()
  });

  assert.deepEqual(definitions.map((definition) => definition.name), [
    "shell_command",
    "exec",
    "exec_command",
    "write_stdin",
    "apply_patch",
    "read_file",
    "list_files",
    "search_files",
    "git_status",
    "git_diff",
    "request_permissions",
    "view_image",
    "tool_search",
    "list_mcp_resources",
    "list_mcp_resource_templates",
    "read_mcp_resource",
    "spawn_agent",
    "wait_agent",
    "get_goal",
    "create_goal",
    "update_goal"
  ]);
  assert.equal(definitions[0].metadata.requiresApproval, true);
});

test("built-in tool specs can include hosted placeholders", () => {
  const definitions = createBuiltinToolDefinitions({
    includeHostedTools: true,
    placeholderHandler: new PlaceholderToolHandler()
  });
  const names = definitions.map((definition) => definition.name);

  assert.equal(names.includes(BUILTIN_TOOL_NAMES.WEB_SEARCH), true);
  assert.equal(names.includes(BUILTIN_TOOL_NAMES.IMAGE_GENERATION), true);
  assert.equal(createWebSearchToolSpec({
    externalWebAccess: true
  }).external_web_access, true);
  assert.equal(createImageGenerationToolSpec({
    outputFormat: "webp"
  }).output_format, "webp");
});

test("ToolRouter runs registered handlers", async () => {
  const router = new ToolRouter({
    tools: [
      {
        name: "test_tool",
        description: "Test tool",
        handler: {
          async run(request) {
            return createToolCallResult({
              callId: request.call_id,
              name: request.name,
              output: "ok"
            });
          }
        }
      }
    ]
  });
  const result = await router.run(createToolCallRequest({
    callId: "call-1",
    name: "test_tool"
  }));

  assert.equal(result.status, TOOL_CALL_RESULT_STATUSES.COMPLETED);
  assert.equal(result.output, "ok");
  assert.deepEqual(router.modelVisibleSpecs().map((spec) => spec.name), ["test_tool"]);
});

test("ToolRouter returns not implemented for missing handlers", async () => {
  const router = new ToolRouter();
  const result = await router.run(createToolCallRequest({
    callId: "call-1",
    name: "missing_tool"
  }));

  assert.equal(result.status, TOOL_CALL_RESULT_STATUSES.FAILED);
  assert.equal(result.error, "not_implemented");
});

test("ToolRouter hides deferred and hidden specs from model-visible list", () => {
  const router = new ToolRouter({
    tools: [
      {
        name: "visible",
        description: "Visible tool",
        metadata: {
          exposure: TOOL_EXPOSURE.MODEL_VISIBLE
        }
      },
      {
        name: "deferred",
        description: "Deferred tool",
        metadata: {
          exposure: TOOL_EXPOSURE.DEFERRED
        }
      },
      {
        name: "hidden",
        description: "Hidden tool",
        metadata: {
          exposure: TOOL_EXPOSURE.HIDDEN
        }
      }
    ]
  });

  assert.deepEqual(router.modelVisibleSpecs().map((spec) => spec.name), ["visible"]);
});

test("ToolRegistry preserves hosted tool spec fields", () => {
  const registry = new ToolRegistry({
    tools: [
      {
        spec: createWebSearchToolSpec({
          externalWebAccess: true,
          searchContentTypes: ["text", "image"]
        })
      }
    ]
  });
  const spec = registry.get(BUILTIN_TOOL_NAMES.WEB_SEARCH).spec;

  assert.equal(spec.type, "web_search");
  assert.equal(spec.external_web_access, true);
  assert.deepEqual(spec.search_content_types, ["text", "image"]);
});

test("upstream-compatible tool specs serialize to Responses API wire shapes", () => {
  const specs = createToolsJsonForResponsesApi([
    createUpstreamToolSpec({
      type: UPSTREAM_TOOL_SPEC_TYPES.FUNCTION,
      name: "read_file",
      description: "Read file",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string"
          }
        },
        required: ["path"],
        additionalProperties: false
      }
    }),
    createUpstreamToolSpec({
      type: UPSTREAM_TOOL_SPEC_TYPES.WEB_SEARCH,
      externalWebAccess: true,
      searchContentTypes: ["text"]
    }),
    createUpstreamToolSpec({
      type: UPSTREAM_TOOL_SPEC_TYPES.IMAGE_GENERATION,
      outputFormat: "webp"
    }),
    createUpstreamToolSpec({
      type: UPSTREAM_TOOL_SPEC_TYPES.TOOL_SEARCH,
      execution: "client",
      description: "Search deferred tools"
    })
  ]);

  assert.equal(specs[0].type, "function");
  assert.equal(specs[0].name, "read_file");
  assert.equal(specs[1].type, "web_search");
  assert.equal(specs[1].external_web_access, true);
  assert.deepEqual(specs[1].search_content_types, ["text"]);
  assert.deepEqual(specs[2], {
    type: "image_generation",
    output_format: "webp"
  });
  assert.equal(specs[3].type, "tool_search");
  assert.equal(upstreamToolSpecName(specs[1]), "web_search");
});

test("upstream-compatible tool definitions can be deferred", () => {
  const definition = createUpstreamToolDefinition({
    name: "git_status",
    description: "Show status",
    inputSchema: {
      type: "object"
    },
    outputSchema: {
      type: "object"
    }
  });
  const deferred = deferUpstreamToolDefinition(definition);

  assert.equal(definition.defer_loading, false);
  assert.equal(deferred.defer_loading, true);
  assert.equal(deferred.output_schema, null);
});

test("upstream-compatible tool payloads expose stable log payloads", () => {
  const fnPayload = createFunctionToolPayload({
    path: "README.md"
  });
  const searchPayload = createToolSearchPayload({
    query: "git"
  });
  const customPayload = createCustomToolPayload("freeform input");

  assert.equal(fnPayload.type, UPSTREAM_TOOL_PAYLOAD_TYPES.FUNCTION);
  assert.equal(fnPayload.arguments, "{\"path\":\"README.md\"}");
  assert.equal(toolPayloadLogPayload(fnPayload), "{\"path\":\"README.md\"}");
  assert.equal(toolPayloadLogPayload(searchPayload), "git");
  assert.equal(toolPayloadLogPayload(customPayload), "freeform input");
});

test("upstream-compatible tool outputs convert to response input items", () => {
  const output = createJsonToolOutput({
    ok: true
  });
  const functionItem = toolOutputToResponseItem(output, "call-1", createFunctionToolPayload({}));
  const customItem = toolOutputToResponseItem(output, "call-2", createCustomToolPayload("input"));

  assert.equal(functionItem.type, "function_call_output");
  assert.equal(functionItem.call_id, "call-1");
  assert.equal(functionItem.output.body, "{\"ok\":true}");
  assert.equal(functionItem.output.success, true);
  assert.equal(customItem.type, "custom_tool_call_output");
  assert.equal(customItem.call_id, "call-2");
  assert.equal(toolOutputSuccessForLogging(output), true);
  assert.equal(toolOutputPostToolUseResponse(output).ok, true);
  assert.deepEqual(toolOutputPostToolUseInput(output, createFunctionToolPayload({
    path: "README.md"
  })), {
    path: "README.md"
  });
  assert.equal(toolOutputCodeModeResult(output, createFunctionToolPayload({})), "{\"ok\":true}");
});

test("upstream-compatible telemetry preview truncates by lines", () => {
  const preview = telemetryPreview("a\nb\nc", {
    maxLines: 2,
    maxBytes: 100
  });

  assert.equal(preview, "a\nb\n[... telemetry preview truncated ...]");
  assert.equal(toolOutputLogPreview(createJsonToolOutput({
    ok: true
  })), "{\"ok\":true}");
});

test("ToolRouter blocks tools through approval gate metadata", async () => {
  const router = new ToolRouter({
    approvalGate: new ApprovalGate({
      policy: new ApprovalPolicy({
        defaultDecision: APPROVAL_DECISIONS.PROMPT
      })
    }),
    tools: [
      {
        name: "needs_approval",
        description: "Needs approval",
        metadata: {
          requiresApproval: true
        },
        handler: {
          async run() {
            return createToolCallResult({
              output: "should not run"
            });
          }
        }
      }
    ]
  });
  const result = await router.run(createToolCallRequest({
    callId: "call-1",
    name: "needs_approval"
  }));

  assert.equal(result.status, TOOL_CALL_RESULT_STATUSES.FAILED);
  assert.equal(result.error, "blocked: prompt");
  assert.equal(result.raw.approval.approvalRequest.resource_type, "tool");
});

test("createToolApprovalGateRequest maps tool metadata", () => {
  const request = createToolApprovalGateRequest("web_search", {
    metadata: {
      q: "codex"
    }
  });

  assert.equal(request.resourceType, "tool");
  assert.equal(request.action, "run");
  assert.equal(request.subject, "web_search");
  assert.deepEqual(request.metadata, {
    q: "codex"
  });
});

test("ToolCallRuntime base class requires implementation", async () => {
  const runtime = new ToolCallRuntime();

  await assert.rejects(
    () => runtime.run(createToolCallRequest({
      callId: "call-1",
      name: "apply_patch"
    })),
    /must be implemented/
  );
});

test("NoopToolCallRuntime returns a safe not implemented result", async () => {
  const runtime = new NoopToolCallRuntime();
  const result = await runtime.run(createToolCallRequest({
    callId: "call-1",
    name: "apply_patch",
    arguments: "{\"patch\":\"noop\"}"
  }));

  assert.equal(result.call_id, "call-1");
  assert.equal(result.name, "apply_patch");
  assert.equal(result.status, TOOL_CALL_RESULT_STATUSES.FAILED);
  assert.equal(result.error, "not_implemented");
  assert.match(result.output, /not implemented/);
});

test("SafeToolCallRuntime dry-runs shell_command tools", async () => {
  const runtime = new SafeToolCallRuntime({
    workingDirectory: "/workspace"
  });
  const result = await runtime.run(createToolCallRequest({
    callId: "call-1",
    name: "shell_command",
    arguments: {
      command: "npm test"
    }
  }));

  assert.equal(result.call_id, "call-1");
  assert.equal(result.name, "shell_command");
  assert.equal(result.status, TOOL_CALL_RESULT_STATUSES.COMPLETED);
  assert.equal(result.output, "dry-run: npm test");
  assert.equal(result.raw.dry_run, true);
  assert.equal(result.raw.exec.dry_run, true);
});

test("ShellCommandToolHandler marks non-zero command exits as failed tool results", async () => {
  const handler = new ShellCommandToolHandler({
    realExecution: true,
    execRunner: {
      async *runCommand() {
        return {
          output: {
            exit_code: 1,
            aggregated_output: {
              text: "ParserError"
            }
          },
          error: null,
          dry_run: false
        };
      }
    }
  });
  const result = await handler.run(createToolCallRequest({
    callId: "shell-failed",
    name: "exec",
    arguments: {
      command: "cat > /root/index.html << 'EOF'"
    }
  }));

  assert.equal(result.status, TOOL_CALL_RESULT_STATUSES.FAILED);
  assert.equal(result.error, "exit_code:1");
  assert.equal(result.output, "ParserError");
});

test("SafeToolCallRuntime view_image reads local image files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-js-view-image-"));

  try {
    const imagePath = path.join(dir, "pixel.png");
    await writeFile(imagePath, Buffer.from([
      0x89, 0x50, 0x4e, 0x47,
      0x0d, 0x0a, 0x1a, 0x0a
    ]));
    const runtime = new SafeToolCallRuntime({
      workingDirectory: dir
    });
    const result = await runtime.run(createToolCallRequest({
      callId: "call-1",
      name: "view_image",
      arguments: {
        path: "pixel.png"
      }
    }));
    const payload = JSON.parse(result.output);

    assert.equal(result.call_id, "call-1");
    assert.equal(result.name, "view_image");
    assert.equal(result.status, TOOL_CALL_RESULT_STATUSES.COMPLETED);
    assert.equal(result.error, null);
    assert.match(payload.image_url, /^data:image\/png;base64,/);
    assert.equal(payload.detail, "high");
  } finally {
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
});

test("SafeToolCallRuntime keeps unified exec session tools as placeholders", async () => {
  const runtime = new SafeToolCallRuntime();
  const result = await runtime.run(createToolCallRequest({
    callId: "call-1",
    name: "exec_command",
    arguments: {
      cmd: "npm test"
    }
  }));

  assert.equal(result.status, TOOL_CALL_RESULT_STATUSES.COMPLETED);
  assert.equal(result.error, null);
  assert.equal(result.raw.exec_command.session_id, 1);
  assert.equal(result.raw.exec_command.dry_run, true);
  assert.match(result.output, /session_id/);

  const stdin = await runtime.run(createToolCallRequest({
    callId: "call-2",
    name: "write_stdin",
    arguments: {
      session_id: result.raw.exec_command.session_id,
      chars: "echo hi\n"
    }
  }));

  assert.equal(stdin.status, TOOL_CALL_RESULT_STATUSES.COMPLETED);
  assert.equal(stdin.error, null);
  assert.match(stdin.raw.write_stdin.output, /stdin accepted/);
});

test("SafeToolCallRuntime model-visible specs include only non-deferred built-ins", () => {
  const runtime = new SafeToolCallRuntime();
  const names = runtime.router.modelVisibleSpecs().map((spec) => spec.name);

  assert.equal(names.includes("shell_command"), true);
  assert.equal(names.includes("apply_patch"), true);
  assert.equal(names.includes("read_file"), true);
  assert.equal(names.includes("list_files"), true);
  assert.equal(names.includes("search_files"), true);
  assert.equal(names.includes("git_status"), true);
  assert.equal(names.includes("git_diff"), true);
  assert.equal(names.includes("view_image"), true);
  assert.equal(names.includes("tool_search"), false);
  assert.equal(names.includes("list_mcp_resources"), false);
  assert.equal(names.includes("get_goal"), false);
});

test("ToolSearchToolHandler searches registered tool metadata", async () => {
  const router = new ToolRouter({
    tools: createBuiltinToolDefinitions({
      placeholderHandler: new PlaceholderToolHandler()
    })
  });
  const result = await new ToolSearchToolHandler().run(createToolCallRequest({
    callId: "search-tools",
    name: "tool_search",
    arguments: {
      query: "git",
      limit: 3
    }
  }), {
    router
  });
  const payload = JSON.parse(result.output);

  assert.equal(result.status, TOOL_CALL_RESULT_STATUSES.COMPLETED);
  assert.equal(payload.query, "git");
  assert.equal(payload.matches.some((entry) => entry.name === "git_status"), true);
  assert.equal(payload.matches.some((entry) => entry.name === "git_diff"), true);
});

test("sub-agent handlers create and read local agent records", async () => {
  const spawnHandler = new SpawnAgentToolHandler();
  const waitHandler = new WaitAgentToolHandler({
    agentCoordinator: spawnHandler.agentCoordinator
  });
  const spawned = await spawnHandler.run(createToolCallRequest({
    callId: "spawn",
    name: "spawn_agent",
    arguments: {
      task: "Inspect tests",
      context: "tools"
    }
  }), {
    threadId: "thread-1"
  });
  const spawnedPayload = JSON.parse(spawned.output);
  const waited = await waitHandler.run(createToolCallRequest({
    callId: "wait",
    name: "wait_agent",
    arguments: {
      agent_id: spawnedPayload.agent_id
    }
  }));
  const waitedPayload = JSON.parse(waited.output);

  assert.equal(spawned.status, TOOL_CALL_RESULT_STATUSES.COMPLETED);
  assert.equal(spawnedPayload.status, "created");
  assert.equal(waited.status, TOOL_CALL_RESULT_STATUSES.COMPLETED);
  assert.equal(waitedPayload.agent_id, spawnedPayload.agent_id);
  assert.equal(waitedPayload.status, "created");
});

test("goal handlers manage per-thread in-memory goals", async () => {
  const goalStore = new InMemoryGoalStore();
  const createGoal = new GoalToolHandler({
    goalStore,
    kind: BUILTIN_TOOL_NAMES.CREATE_GOAL
  });
  const updateGoal = new GoalToolHandler({
    goalStore,
    kind: BUILTIN_TOOL_NAMES.UPDATE_GOAL
  });
  const getGoal = new GoalToolHandler({
    goalStore,
    kind: BUILTIN_TOOL_NAMES.GET_GOAL
  });
  const context = {
    threadId: "thread-goal"
  };
  const created = await createGoal.run(createToolCallRequest({
    callId: "create",
    name: "create_goal",
    arguments: {
      objective: "finish terminal tools",
      token_budget: 100
    }
  }), context);
  const updated = await updateGoal.run(createToolCallRequest({
    callId: "update",
    name: "update_goal",
    arguments: {
      status: "complete"
    }
  }), context);
  const current = await getGoal.run(createToolCallRequest({
    callId: "get",
    name: "get_goal"
  }), context);

  assert.equal(created.status, TOOL_CALL_RESULT_STATUSES.COMPLETED);
  assert.equal(JSON.parse(updated.output).goal.status, "complete");
  assert.equal(JSON.parse(current.output).goal.objective, "finish terminal tools");
});

test("hosted provider handler delegates only when a provider is configured", async () => {
  const missing = await new HostedProviderToolHandler({
    kind: "web_search"
  }).run(createToolCallRequest({
    callId: "missing",
    name: "web_search",
    arguments: {
      query: "codex"
    }
  }));
  const configured = await new HostedProviderToolHandler({
    kind: "web_search",
    provider(args) {
      return {
        results: [
          {
            title: args.query,
            url: "https://example.test"
          }
        ]
      };
    }
  }).run(createToolCallRequest({
    callId: "configured",
    name: "web_search",
    arguments: {
      query: "codex"
    }
  }));

  assert.equal(missing.status, TOOL_CALL_RESULT_STATUSES.FAILED);
  assert.equal(missing.error, "provider_not_configured");
  assert.equal(configured.status, TOOL_CALL_RESULT_STATUSES.COMPLETED);
  assert.equal(JSON.parse(configured.output).results[0].title, "codex");
});

test("HttpHostedToolProvider posts hosted tool payloads", async () => {
  const requests = [];
  const provider = new HttpHostedToolProvider({
    url: "https://hosted.example/tool",
    headers: {
      "x-test": "yes"
    },
    fetch: async (url, request) => {
      requests.push({
        url,
        headers: request.headers,
        body: JSON.parse(request.body)
      });

      return {
        ok: true,
        headers: {
          get() {
            return "application/json";
          }
        },
        async json() {
          return {
            ok: true
          };
        }
      };
    }
  });
  const result = await provider.run({
    query: "codex"
  }, {
    kind: "web_search",
    request: {
      name: "web_search"
    }
  });

  assert.equal(result.ok, true);
  assert.equal(requests[0].url, "https://hosted.example/tool");
  assert.equal(requests[0].headers["x-test"], "yes");
  assert.equal(requests[0].body.kind, "web_search");
  assert.equal(requests[0].body.arguments.query, "codex");
});

test("file tools read, list, and search workspace files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-js-file-tools-"));

  try {
    await mkdir(path.join(dir, "src"));
    await writeFile(path.join(dir, "src", "app.js"), "hello\nneedle\n", "utf8");
    const read = await new ReadFileToolHandler({
      workingDirectory: dir
    }).run(createToolCallRequest({
      callId: "read",
      name: "read_file",
      arguments: {
        path: "src/app.js"
      }
    }));
    const list = await new ListFilesToolHandler({
      workingDirectory: dir
    }).run(createToolCallRequest({
      callId: "list",
      name: "list_files",
      arguments: {
        path: ".",
        recursive: true
      }
    }));
    const search = await new SearchFilesToolHandler({
      workingDirectory: dir
    }).run(createToolCallRequest({
      callId: "search",
      name: "search_files",
      arguments: {
        path: ".",
        query: "needle"
      }
    }));

    assert.equal(read.output, "hello\nneedle\n");
    assert.match(list.output.replace(/\\/g, "/"), /src\/app\.js/);
    assert.match(search.output.replace(/\\/g, "/"), /src\/app\.js:2: needle/);
  } finally {
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
});

test("file tools honor sandbox read roots", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-js-file-sandbox-"));
  const outside = await mkdtemp(path.join(tmpdir(), "codex-js-file-outside-"));

  try {
    await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    const runtime = new SafeToolCallRuntime({
      workingDirectory: dir,
      sandboxPolicy: new SandboxPolicy({
        mode: "workspace-write",
        workingDirectory: dir
      })
    });
    const result = await runtime.run(createToolCallRequest({
      callId: "read",
      name: "read_file",
      arguments: {
        path: path.join(outside, "secret.txt")
      }
    }));

    assert.equal(result.status, TOOL_CALL_RESULT_STATUSES.FAILED);
    assert.equal(result.error, "sandbox_denied");
  } finally {
    await rm(dir, {
      recursive: true,
      force: true
    });
    await rm(outside, {
      recursive: true,
      force: true
    });
  }
});

test("git tools route status and diff through exec runner", async () => {
  const execRunner = {
    commands: [],
    async *runCommand(request) {
      this.commands.push(request.command);
      return {
        output: {
          aggregated_output: {
            text: `ran: ${request.command}`
          }
        },
        error: null
      };
    }
  };
  const status = await new GitStatusToolHandler({
    execRunner
  }).run(createToolCallRequest({
    callId: "status",
    name: "git_status"
  }));
  const diff = await new GitDiffToolHandler({
    execRunner
  }).run(createToolCallRequest({
    callId: "diff",
    name: "git_diff",
    arguments: {
      staged: true,
      path: "src/app.js"
    }
  }));

  assert.equal(status.output, "ran: git status --short --branch");
  assert.equal(diff.output, "ran: git diff --staged -- \"src/app.js\"");
  assert.deepEqual(execRunner.commands, [
    "git status --short --branch",
    "git diff --staged -- \"src/app.js\""
  ]);
});

test("SafeToolCallRuntime parses apply_patch dry-runs", async () => {
  const runtime = new SafeToolCallRuntime();
  const result = await runtime.run(createToolCallRequest({
    callId: "call-1",
    name: "apply_patch",
    arguments: {
      patch: `*** Begin Patch
*** Add File: README.md
+hello
*** End Patch`
    }
  }));

  assert.equal(result.status, TOOL_CALL_RESULT_STATUSES.COMPLETED);
  assert.equal(result.error, null);
  assert.match(result.output, /patch was not applied/);
  assert.equal(result.raw.dry_run, true);
  assert.equal(result.raw.apply_patch.summary.add, 1);
  assert.deepEqual(result.raw.apply_patch.summary.files, ["README.md"]);
});

test("SafeToolCallRuntime returns parse_error for invalid patches", async () => {
  const runtime = new SafeToolCallRuntime();
  const result = await runtime.run(createToolCallRequest({
    callId: "call-1",
    name: "apply_patch",
    arguments: {
      patch: "bad patch"
    }
  }));

  assert.equal(result.status, TOOL_CALL_RESULT_STATUSES.FAILED);
  assert.equal(result.error, "parse_error");
  assert.match(result.output, /parse error/);
});

test("SafeToolCallRuntime can compute apply_patch plans when explicitly allowed", async () => {
  const runtime = new SafeToolCallRuntime({
    allowApplyPatch: true,
    workingDirectory: "/workspace",
    applyPatchFileProvider: {
      "README.md": "old\n"
    }
  });
  const result = await runtime.run(createToolCallRequest({
    callId: "call-1",
    name: "apply_patch",
    arguments: {
      patch: `*** Begin Patch
*** Update File: README.md
@@
-old
+new
*** End Patch`
    }
  }));

  assert.equal(result.status, TOOL_CALL_RESULT_STATUSES.COMPLETED);
  assert.equal(result.error, null);
  assert.match(result.output, /plan computed successfully/);
  assert.equal(result.raw.dry_run, true);
  assert.equal(result.raw.apply_patch.plan.changes[0].newContent, "new\n");
});

test("SafeToolCallRuntime reports apply_patch application errors behind allowApplyPatch", async () => {
  const runtime = new SafeToolCallRuntime({
    allowApplyPatch: true,
    workingDirectory: "/workspace",
    applyPatchFileProvider: {
      "README.md": "different\n"
    }
  });
  const result = await runtime.run(createToolCallRequest({
    callId: "call-1",
    name: "apply_patch",
    arguments: {
      patch: `*** Begin Patch
*** Update File: README.md
@@
-old
+new
*** End Patch`
    }
  }));

  assert.equal(result.status, TOOL_CALL_RESULT_STATUSES.FAILED);
  assert.equal(result.error, "expected_lines_not_found");
  assert.match(result.output, /application error/);
});

test("SafeToolCallRuntime applies patches only with the explicit write gate", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-js-tool-apply-"));

  try {
    const runtime = new SafeToolCallRuntime({
      allowApplyPatchWrites: true,
      workingDirectory: dir
    });
    const result = await runtime.run(createToolCallRequest({
      callId: "call-1",
      name: "apply_patch",
      arguments: {
        patch: `*** Begin Patch
*** Add File: created.txt
+created
*** End Patch`
      }
    }));

    assert.equal(result.status, TOOL_CALL_RESULT_STATUSES.COMPLETED);
    assert.equal(result.error, null);
    assert.equal(result.raw.dry_run, false);
    assert.match(result.output, /Success/);
    assert.equal(await readFile(path.join(dir, "created.txt"), "utf8"), "created");
  } finally {
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
});

test("SafeToolCallRuntime blocks apply_patch writes when approval gate prompts", async () => {
  const runtime = new SafeToolCallRuntime({
    allowApplyPatchWrites: true,
    workingDirectory: "/workspace",
    approvalGate: new ApprovalGate({
      policy: new ApprovalPolicy({
        defaultDecision: APPROVAL_DECISIONS.PROMPT
      })
    })
  });
  const result = await runtime.run(createToolCallRequest({
    callId: "call-1",
    name: "apply_patch",
    arguments: {
      patch: `*** Begin Patch
*** Add File: created.txt
+created
*** End Patch`
    }
  }));

  assert.equal(result.status, TOOL_CALL_RESULT_STATUSES.FAILED);
  assert.equal(result.error, "blocked: prompt");
  assert.equal(result.raw.approval.approvalRequest.resource_type, "apply_patch");
});

test("SafeToolCallRuntime allows apply_patch writes when approval gate allows", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-js-tool-approval-"));

  try {
    const runtime = new SafeToolCallRuntime({
      allowApplyPatchWrites: true,
      workingDirectory: dir,
      approvalGate: new ApprovalGate({
        policy: new ApprovalPolicy({
          rules: [
            {
              resourceType: "apply_patch",
              action: "write",
              subject: dir,
              decision: APPROVAL_DECISIONS.ALLOW
            }
          ]
        })
      })
    });
    const result = await runtime.run(createToolCallRequest({
      callId: "call-1",
      name: "apply_patch",
      arguments: {
        patch: `*** Begin Patch
*** Add File: created.txt
+created
*** End Patch`
      }
    }));

    assert.equal(result.status, TOOL_CALL_RESULT_STATUSES.COMPLETED);
    assert.equal(await readFile(path.join(dir, "created.txt"), "utf8"), "created");
  } finally {
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
});

test("permission profile grants are intersected with requested permissions", () => {
  const result = intersectPermissionProfiles({
    network: {
      enabled: true
    },
    fileSystem: {
      read: ["/workspace"],
      write: ["/workspace", "/tmp"]
    }
  }, {
    network: {
      enabled: true
    },
    fileSystem: {
      read: ["/workspace", "/etc"],
      write: ["/tmp", "/secret"]
    }
  });

  assert.deepEqual(result, {
    network: {
      enabled: true
    },
    fileSystem: {
      read: ["/workspace"],
      write: ["/tmp"]
    }
  });
});

test("permissions client responses normalize scope and ignore unrequested grants", () => {
  const result = createPermissionsResponseFromClientResult({
    requested: {
      fileSystem: {
        write: ["/workspace"]
      }
    },
    response: {
      result: {
        scope: "session",
        permissions: {
          network: {
            enabled: true
          },
          fileSystem: {
            write: ["/workspace", "/secret"]
          }
        }
      }
    }
  });

  assert.equal(result.scope, "session");
  assert.deepEqual(result.permissions, {
    fileSystem: {
      write: ["/workspace"]
    }
  });
});

test("SafeToolCallRuntime request_permissions creates approval server requests", async () => {
  const serverRequests = [];
  const serverRequestStore = new ServerRequestStore({
    onRequest(request) {
      serverRequests.push(request);
    }
  });
  const runtime = new SafeToolCallRuntime({
    serverRequestStore,
    approvalGate: new ApprovalGate({
      policy: new ApprovalPolicy({
        defaultDecision: APPROVAL_DECISIONS.PROMPT
      })
    })
  });
  const result = await runtime.run(createToolCallRequest({
    callId: "call-permissions",
    name: BUILTIN_TOOL_NAMES.REQUEST_PERMISSIONS,
    arguments: {
      reason: "Need workspace writes",
      environment_id: "local",
      permissions: {
        fileSystem: {
          write: ["/workspace"]
        }
      }
    }
  }), {
    threadId: "thread-1",
    turnId: "turn-1"
  });

  assert.equal(result.status, TOOL_CALL_RESULT_STATUSES.FAILED);
  assert.equal(result.error, "approval_required");
  assert.equal(result.raw.serverRequest.method, "item/permissions/requestApproval");
  assert.equal(serverRequests.length, 1);
  assert.equal(serverRequests[0].params.threadId, "thread-1");
  assert.equal(serverRequests[0].params.turnId, "turn-1");
  assert.equal(serverRequests[0].params.itemId, "call-permissions");
  assert.deepEqual(serverRequests[0].params.permissions.fileSystem.write, ["/workspace"]);
});

test("SafeToolCallRuntime request_permissions records turn grants when allowed", async () => {
  const permissionGrantStore = new PermissionGrantStore();
  const runtime = new SafeToolCallRuntime({
    permissionGrantStore,
    approvalGate: new ApprovalGate({
      policy: new ApprovalPolicy({
        defaultDecision: APPROVAL_DECISIONS.ALLOW
      })
    })
  });
  const result = await runtime.run(createToolCallRequest({
    callId: "call-permissions",
    name: BUILTIN_TOOL_NAMES.REQUEST_PERMISSIONS,
    arguments: {
      permissions: {
        network: {
          enabled: true
        }
      }
    }
  }), {
    threadId: "thread-1",
    turnId: "turn-1"
  });

  assert.equal(result.status, TOOL_CALL_RESULT_STATUSES.COMPLETED);
  assert.equal(permissionGrantStore.list({
    threadId: "thread-1",
    turnId: "turn-1"
  }).length, 1);
  assert.deepEqual(result.raw.permissions, {
    network: {
      enabled: true
    }
  });
});

test("SafeToolCallRuntime request_permissions expands sandbox read roots for the turn", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-js-permissions-cwd-"));
  const outside = await mkdtemp(path.join(tmpdir(), "codex-js-permissions-outside-"));

  try {
    await writeFile(path.join(outside, "allowed.txt"), "granted read", "utf8");
    const sandboxPolicy = new SandboxPolicy({
      mode: "workspace-write",
      workingDirectory: dir
    });
    const runtime = new SafeToolCallRuntime({
      workingDirectory: dir,
      sandboxPolicy,
      approvalGate: new ApprovalGate({
        policy: new ApprovalPolicy({
          defaultDecision: APPROVAL_DECISIONS.ALLOW
        })
      })
    });
    const blocked = await runtime.run(createToolCallRequest({
      callId: "read-before",
      name: "read_file",
      arguments: {
        path: path.join(outside, "allowed.txt")
      }
    }));

    assert.equal(blocked.status, TOOL_CALL_RESULT_STATUSES.FAILED);
    assert.equal(blocked.error, "sandbox_denied");

    const permissions = await runtime.run(createToolCallRequest({
      callId: "permissions",
      name: BUILTIN_TOOL_NAMES.REQUEST_PERMISSIONS,
      arguments: {
        permissions: {
          fileSystem: {
            read: [outside]
          }
        }
      }
    }));
    const allowed = await runtime.run(createToolCallRequest({
      callId: "read-after",
      name: "read_file",
      arguments: {
        path: path.join(outside, "allowed.txt")
      }
    }));

    assert.equal(permissions.status, TOOL_CALL_RESULT_STATUSES.COMPLETED);
    assert.equal(permissions.raw.sandbox.applied, true);
    assert.equal(permissions.raw.sandbox.readRoots.includes(path.resolve(outside)), true);
    assert.equal(allowed.status, TOOL_CALL_RESULT_STATUSES.COMPLETED);
    assert.equal(allowed.output, "granted read");
  } finally {
    await rm(dir, {
      recursive: true,
      force: true
    });
    await rm(outside, {
      recursive: true,
      force: true
    });
  }
});

test("normalizeToolArguments parses JSON strings and preserves freeform input", () => {
  assert.deepEqual(normalizeToolArguments("{\"x\":1}"), {
    x: 1
  });
  assert.equal(normalizeToolArguments("freeform"), "freeform");
});

test("tool argument helpers extract command and patch text", () => {
  assert.equal(commandFromToolArguments({
    command: ["npm", "test"]
  }), "npm test");
  assert.equal(commandFromToolArguments({
    cmd: "pnpm test"
  }), "pnpm test");
  assert.equal(patchFromToolArguments({
    patch: "patch"
  }), "patch");
});
