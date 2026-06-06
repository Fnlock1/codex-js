import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { Codex } from "./codex.js";
import {
  applyCliConfigOverrides,
  configToCodexOptions,
  createDefaultConfig,
  loadCodexJsConfig,
  redactCodexJsConfig
} from "./config.js";
import {
  createExecEventProcessor,
  processEventStream
} from "./exec/event-processor.js";
import { ExecRunner } from "./exec/runner.js";
import { ExecPermissionPolicy } from "./exec/permission-policy.js";
import { RealExecRuntime } from "./exec/runtime.js";
import { LoopingTurnRuntime } from "./core/looping-turn-runtime.js";
import { createHttpModelClient } from "./model-adapters/http-model-client.js";
import {
  createDeepSeekModelClient,
  createOpenAICompatibleModelClient
} from "./model-adapters/openai-compatible-model-client.js";
import { createPluginModelClient } from "./model-adapters/plugin-model-client.js";
import { AgentCoordinator } from "./agents/coordinator.js";
import {
  APPROVAL_DECISIONS,
  APPROVAL_REVIEW_DECISIONS,
  ApprovalPolicy
} from "./approval/policy.js";
import { createManagedMcpClient } from "./mcp/managed-client.js";
import { McpRuntime } from "./mcp/runtime.js";
import {
  SandboxPolicy
} from "./sandbox/policy.js";
import { createHttpHostedToolProvider } from "./tools/hosted-providers.js";
import { SafeToolCallRuntime } from "./tools/runtime.js";
import {
  createToolDoctorFindings,
  createToolCapabilityReport,
  formatToolDoctorText,
  formatToolReportText
} from "./tools/report.js";
import {
  APP_SERVER_METHODS,
  createInProcessAppServerTransport,
  createStdioAppServerTransport,
  createRpcRequest
} from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = resolve(__dirname, "../package.json");

export async function runCli(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const stdin = io.stdin ?? process.stdin;
  const parsed = parseArgs(argv);
  parsed.stdin = stdin;
  parsed.stderr = stderr;

  if (parsed.help || parsed.command === "help") {
    stdout.write(helpText());
    return 0;
  }

  if (parsed.version) {
    stdout.write(`${await packageVersion()}\n`);
    return 0;
  }

  if (parsed.unknown.length > 0) {
    stderr.write(`Unknown option: ${parsed.unknown[0]}\n`);
    return 1;
  }

  if (parsed.errors.length > 0) {
    stderr.write(`${parsed.errors[0]}\n`);
    return 1;
  }

  if (parsed.command === "config") {
    return await runConfigCommand(parsed, {
      stdout,
      stderr
    });
  }

  if (parsed.command === "app-server") {
    return await runAppServerCommand(parsed, {
      stdin: io.stdin ?? process.stdin,
      stdout,
      stderr
    });
  }

  if (parsed.command === "thread") {
    return await runThreadCommand(parsed, {
      stdout,
      stderr
    });
  }

  if (parsed.command === "tools") {
    return await runToolsCommand(parsed, {
      stdout,
      stderr
    });
  }

  if (parsed.command === "chat") {
    return await runChatCommand(parsed, {
      stdin,
      stdout,
      stderr
    });
  }

  if (!parsed.prompt) {
    if (!parsed.command && stdin?.isTTY) {
      return await runChatCommand(parsed, {
        stdin,
        stdout,
        stderr
      });
    }

    stdout.write(helpText());
    return 0;
  }

  const config = applyCliConfigOverrides(
    await loadCodexJsConfig(parsed.configPath),
    parsed
  );
  const codex = await createCodexForCli(config, parsed);

  if (parsed.dryRunCommand) {
    const runner = new ExecRunner({
      workingDirectory: config.workingDirectory ?? parsed.workingDirectory
    });
    const processor = createExecEventProcessor({
      json: parsed.json,
      stdout,
      stderr
    });

    await processEventStream(runner.runDryCommand({
      command: parsed.dryRunCommand,
      cwd: config.workingDirectory ?? parsed.workingDirectory
    }), processor);
    return 0;
  }

  const thread = parsed.resume
    ? codex.resumeThread(parsed.resume)
    : codex.startThread();

  if (parsed.json) {
    const streamed = await thread.runStreamed(parsed.prompt);
    await processEventStream(streamed.events, createExecEventProcessor({
      json: true,
      stdout,
      stderr
    }));
    return 0;
  }

  const streamed = await thread.runStreamed(parsed.prompt);
  await processEventStream(streamed.events, createExecEventProcessor({
    json: false,
    stdout,
    stderr
  }));
  return 0;
}

export function parseArgs(argv) {
  const args = [...argv];
  const parsed = {
    command: null,
    subcommand: null,
    prompt: "",
    json: false,
    help: false,
    version: false,
    resume: null,
    workingDirectory: undefined,
    sessionStoreDirectory: undefined,
    mockResponse: undefined,
    dryRunCommand: undefined,
    modelAdapterPath: undefined,
    modelUrl: undefined,
    modelProvider: undefined,
    modelName: undefined,
    modelBaseUrl: undefined,
    modelApiKey: undefined,
    modelHeaders: {},
    modelOptions: {},
    modelTimeoutMs: undefined,
    maxToolIterations: undefined,
    enableHostedTools: false,
    webSearchUrl: undefined,
    imageGenerationUrl: undefined,
    hostedToolHeaders: {},
    allowMcp: false,
    mcpServers: [],
    allowShell: false,
    allowApplyPatch: false,
    yes: false,
    sandboxMode: undefined,
    sandboxReadRoots: [],
    sandboxWriteRoots: [],
    allowNetwork: undefined,
    blockedEnvKeys: [],
    allowedEnvKeys: [],
    configPath: undefined,
    threadId: undefined,
    limit: undefined,
    cursor: undefined,
    archived: false,
    searchTerm: undefined,
    dropLastTurns: undefined,
    metadata: undefined,
    unknown: [],
    errors: []
  };
  const positional = [];

  if (args[0] && !args[0].startsWith("-")) {
    parsed.command = args.shift();
  }

  if (["config", "app-server", "thread", "tools"].includes(parsed.command)) {
    parsed.subcommand = args[0] && !args[0].startsWith("-") ? args.shift() : null;
  } else if (parsed.command && !["exec", "chat", "help"].includes(parsed.command)) {
    args.unshift(parsed.command);
    parsed.command = "exec";
  }

  while (args.length > 0) {
    const arg = args.shift();

    switch (arg) {
      case "--json":
      case "--json-stream":
        parsed.json = true;
        break;
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--version":
      case "-v":
        parsed.version = true;
        break;
      case "--resume":
        parsed.resume = args.shift() ?? "";
        break;
      case "--cwd":
        parsed.workingDirectory = args.shift();
        break;
      case "--session-store":
        parsed.sessionStoreDirectory = args.shift();
        break;
      case "--config":
        parsed.configPath = args.shift();
        break;
      case "--mock-response":
        parsed.mockResponse = args.shift() ?? "";
        break;
      case "--dry-run-command":
        parsed.dryRunCommand = args.shift() ?? "";
        break;
      case "--model-adapter":
        parsed.modelAdapterPath = args.shift() ?? "";
        break;
      case "--model-url":
        parsed.modelUrl = args.shift() ?? "";
        break;
      case "--model-provider":
        parsed.modelProvider = args.shift() ?? "";
        break;
      case "--model":
        parsed.modelName = args.shift() ?? "";
        break;
      case "--model-base-url":
        parsed.modelBaseUrl = args.shift() ?? "";
        break;
      case "--model-api-key":
        parsed.modelApiKey = args.shift() ?? "";
        break;
      case "--model-header":
        parseKeyValueOption(args.shift(), {
          target: parsed.modelHeaders,
          errors: parsed.errors,
          label: "--model-header"
        });
        break;
      case "--model-option":
        parseKeyValueOption(args.shift(), {
          target: parsed.modelOptions,
          errors: parsed.errors,
          label: "--model-option",
          parseJsonValue: true
        });
        break;
      case "--model-options-json":
        parseJsonObjectOption(args.shift(), {
          target: parsed.modelOptions,
          errors: parsed.errors,
          label: "--model-options-json"
        });
        break;
      case "--model-timeout":
        parsed.modelTimeoutMs = args.shift() ?? "";
        break;
      case "--max-tool-iterations":
        parsed.maxToolIterations = parsePositiveIntegerOption(args.shift(), {
          errors: parsed.errors,
          label: "--max-tool-iterations"
        });
        break;
      case "--enable-hosted-tools":
        parsed.enableHostedTools = true;
        break;
      case "--web-search-url":
        parsed.webSearchUrl = args.shift() ?? "";
        break;
      case "--image-generation-url":
        parsed.imageGenerationUrl = args.shift() ?? "";
        break;
      case "--hosted-tool-header":
        parseKeyValueOption(args.shift(), {
          target: parsed.hostedToolHeaders,
          errors: parsed.errors,
          label: "--hosted-tool-header"
        });
        break;
      case "--allow-mcp":
        parsed.allowMcp = true;
        break;
      case "--mcp-server":
        parsed.mcpServers.push(args.shift() ?? "");
        break;
      case "--allow-shell":
        parsed.allowShell = true;
        break;
      case "--allow-apply-patch":
        parsed.allowApplyPatch = true;
        break;
      case "--yes":
      case "-y":
        parsed.yes = true;
        break;
      case "--sandbox":
        parsed.sandboxMode = args.shift() ?? "";
        break;
      case "--sandbox-read-root":
        parsed.sandboxReadRoots.push(args.shift() ?? "");
        break;
      case "--sandbox-write-root":
        parsed.sandboxWriteRoots.push(args.shift() ?? "");
        break;
      case "--allow-network":
        parsed.allowNetwork = true;
        break;
      case "--block-env":
        parsed.blockedEnvKeys.push(args.shift() ?? "");
        break;
      case "--allow-env":
        parsed.allowedEnvKeys.push(args.shift() ?? "");
        break;
      case "--thread-id":
        parsed.threadId = args.shift() ?? "";
        break;
      case "--limit":
        parsed.limit = args.shift() ?? "";
        break;
      case "--cursor":
        parsed.cursor = args.shift() ?? "";
        break;
      case "--archived":
        parsed.archived = true;
        break;
      case "--search":
        parsed.searchTerm = args.shift() ?? "";
        break;
      case "--drop-last-turns":
        parsed.dropLastTurns = args.shift() ?? "";
        break;
      case "--metadata":
        parsed.metadata = args.shift() ?? "";
        break;
      default:
        if (arg?.startsWith("-")) {
          parsed.unknown.push(arg);
        } else {
          positional.push(arg);
        }
        break;
    }
  }

  parsed.prompt = positional.join(" ");
  return parsed;
}

async function createCodexForCli(config, parsed) {
  const modelClient = await createModelClientForCli(config);
  const options = {
    ...configToCodexOptions(config)
  };

  if (modelClient) {
    const toolRuntime = createToolRuntimeForCli(config, parsed, {
      modelClient
    });
    if (config.tools?.mcp?.enabled) {
      await toolRuntime.loadMcpTools();
    }
    options.runtime = new LoopingTurnRuntime({
      modelClient,
      mockResponse: config.mockResponse ?? undefined,
      toolRuntime,
      maxToolIterations: parsed.maxToolIterations ?? config.runtime?.maxToolIterations
    });
    options.toolRegistry = toolRuntime.router;
  }

  return new Codex(options);
}

function createToolRuntimeForCli(config, parsed, options = {}) {
  const workingDirectory = config.workingDirectory ?? parsed.workingDirectory ?? process.cwd();
  const approvalGate = new CliApprovalGate({
    stdin: parsed.stdin,
    stderr: parsed.stderr,
    autoApprove: parsed.yes,
    policy: new ApprovalPolicy({
      defaultDecision: APPROVAL_DECISIONS.PROMPT
    })
  });
  const sandboxPolicy = new SandboxPolicy({
    mode: parsed.sandboxMode ?? config.sandbox?.mode,
    workingDirectory,
    readRoots: parsed.sandboxReadRoots.length > 0
      ? parsed.sandboxReadRoots
      : config.sandbox?.readRoots ?? config.sandbox?.read_roots,
    writeRoots: parsed.sandboxWriteRoots.length > 0
      ? parsed.sandboxWriteRoots
      : config.sandbox?.writeRoots ?? config.sandbox?.write_roots,
    networkAllowed: parsed.allowNetwork ?? config.sandbox?.networkAllowed ?? config.sandbox?.network_allowed,
    blockedEnvKeys: parsed.blockedEnvKeys.length > 0
      ? parsed.blockedEnvKeys
      : config.sandbox?.blockedEnvKeys ?? config.sandbox?.blocked_env_keys,
    allowedEnvKeys: parsed.allowedEnvKeys.length > 0
      ? parsed.allowedEnvKeys
      : config.sandbox?.allowedEnvKeys ?? config.sandbox?.allowed_env_keys
  });
  const execRunner = new ExecRunner({
    workingDirectory,
    approvalGate,
    sandboxPolicy,
    permissionPolicy: new ExecPermissionPolicy({
      defaultDecision: parsed.allowShell
        ? "allow"
        : "forbidden"
    }),
    runtime: parsed.allowShell
      ? new RealExecRuntime({
          blockedEnvKeys: sandboxPolicy.blockedEnvKeys ? [...sandboxPolicy.blockedEnvKeys] : [],
          allowedEnvKeys: sandboxPolicy.allowedEnvKeys ? [...sandboxPolicy.allowedEnvKeys] : []
        })
      : undefined
  });
  const agentCoordinator = new AgentCoordinator();
  let toolRuntime;
  const mcpRuntime = config.tools?.mcp?.enabled
    ? new McpRuntime({
        approvalGate,
        client: createManagedMcpClient({
          servers: config.tools.mcp.servers,
          allowStdioSpawn: config.tools.mcp.allowStdioSpawn,
          defaultTimeoutMs: 5000
        })
      })
    : null;
  const webSearchProvider = config.tools?.hosted?.webSearchUrl
    ? createHttpHostedToolProvider({
        url: config.tools.hosted.webSearchUrl,
        headers: config.tools.hosted.headers
      })
    : null;
  const imageGenerationProvider = config.tools?.hosted?.imageGenerationUrl
    ? createHttpHostedToolProvider({
        url: config.tools.hosted.imageGenerationUrl,
        headers: config.tools.hosted.headers
      })
    : null;

  toolRuntime = new SafeToolCallRuntime({
    workingDirectory,
    approvalGate,
    sandboxPolicy,
    execRunner,
    mcpRuntime,
    agentCoordinator,
    allowShell: parsed.allowShell,
    allowApplyPatch: true,
    allowApplyPatchWrites: parsed.allowApplyPatch,
    includeHostedTools: config.tools?.hosted?.enabled ?? false,
    webSearchProvider,
    imageGenerationProvider
  });

  agentCoordinator.runner = async (agent) => {
    const runtime = new LoopingTurnRuntime({
      modelClient: options.modelClient,
      toolRuntime,
      maxToolIterations: parsed.maxToolIterations ?? config.runtime?.subAgentMaxToolIterations ?? 3
    });
    const codex = new Codex({
      workingDirectory,
      sessionStoreDirectory: config.sessionStoreDirectory ?? undefined,
      runtime,
      toolRegistry: toolRuntime.router
    });
    const result = await codex.startThread().run(formatSubAgentPrompt(agent));

    return {
      finalResponse: result.finalResponse,
      failed: result.failed,
      error: result.error,
      threadId: result.threadId
    };
  };

  return toolRuntime;
}

function formatSubAgentPrompt(agent) {
  const context = agent.metadata?.context
    ? `\nContext:\n${agent.metadata.context}`
    : "";

  return `Sub-agent task:\n${agent.task}${context}`;
}

async function createModelClientForCli(config) {
  const provider = parsedProvider(config);

  if (config.model.provider === "plugin" || config.model.adapterPath) {
    if (!config.model.adapterPath) {
      throw new Error("Model provider 'plugin' requires model.adapterPath or --model-adapter.");
    }

    return await createPluginModelClient({
      modulePath: resolve(config.model.adapterPath),
      adapterOptions: config.model.options
    });
  }

  if (config.model.provider === "http" || config.model.url) {
    if (!config.model.url) {
      throw new Error("Model provider 'http' requires model.url or --model-url.");
    }

    return createHttpModelClient({
      url: config.model.url,
      headers: config.model.headers,
      timeoutMs: config.model.timeoutMs,
      sessionOptions: config.model.options
    });
  }

  if (provider === "deepseek") {
    return createDeepSeekModelClient({
      ...config.model.options,
      apiKey: config.model.options.apiKey ?? config.model.options.api_key,
      model: config.model.options.model ?? "deepseek-v4-pro",
      baseUrl: config.model.options.baseUrl ?? config.model.options.base_url,
      headers: config.model.headers,
      timeoutMs: config.model.timeoutMs
    });
  }

  if (provider === "openai-compatible") {
    return createOpenAICompatibleModelClient({
      ...config.model.options,
      apiKey: config.model.options.apiKey ?? config.model.options.api_key,
      model: config.model.options.model,
      baseUrl: config.model.options.baseUrl ?? config.model.options.base_url,
      headers: config.model.headers,
      timeoutMs: config.model.timeoutMs
    });
  }

  return null;
}

function parsedProvider(config) {
  return String(config.model.provider ?? "").toLowerCase();
}

async function runChatCommand(parsed, io = {}) {
  const stdin = io.stdin;
  const stdout = io.stdout;
  const stderr = io.stderr;
  const config = applyCliConfigOverrides(
    await loadCodexJsConfig(parsed.configPath),
    parsed
  );
  const codex = await createCodexForCli(config, parsed);
  let thread = parsed.resume
    ? codex.resumeThread(parsed.resume)
    : codex.startThread();
  const terminal = Boolean(stdin?.isTTY && stdout?.isTTY);

  if (terminal) {
    stdout.write(`codex-js terminal\nthread ${thread.id}\nType /help for commands, /exit to quit.\n`);
  }

  if (parsed.prompt) {
    await runChatPrompt(thread, parsed.prompt, parsed, {
      stdout,
      stderr
    });
  }

  if (!stdin?.readable) {
    return 0;
  }

  const rl = createInterface({
    input: stdin,
    output: terminal ? stdout : undefined,
    terminal
  });

  try {
    if (terminal) {
      stdout.write("codex-js> ");
    }

    for await (const rawLine of rl) {
      const line = String(rawLine ?? "").trim();

      if (!line) {
        if (terminal) {
          stdout.write("codex-js> ");
        }
        continue;
      }

      if (chatExitCommands.has(line)) {
        break;
      }

      if (chatHelpCommands.has(line)) {
        stdout.write(chatHelpText());
      } else if (line === "/thread" || line === ".thread") {
        stdout.write(`${thread.id}\n`);
      } else if (line === "/clear" || line === ".clear") {
        thread = codex.startThread();
        stdout.write(`thread ${thread.id}\n`);
      } else {
        await runChatPrompt(thread, line, parsed, {
          stdout,
          stderr
        });
      }

      if (terminal) {
        stdout.write("codex-js> ");
      }
    }
  } finally {
    rl.close();
  }

  return 0;
}

async function runChatPrompt(thread, prompt, parsed, io = {}) {
  const streamed = await thread.runStreamed(prompt);
  await processEventStream(streamed.events, createExecEventProcessor({
    json: parsed.json,
    stdout: io.stdout,
    stderr: parsed.json ? io.stderr : io.stdout
  }));
}

async function runConfigCommand(parsed, io = {}) {
  const stdout = io.stdout;

  switch (parsed.subcommand ?? "inspect") {
    case "default":
      stdout.write(`${JSON.stringify(createDefaultConfig(), null, 2)}\n`);
      return 0;
    case "inspect": {
      const config = applyCliConfigOverrides(
        await loadCodexJsConfig(parsed.configPath),
        parsed
      );
      stdout.write(`${JSON.stringify(redactCodexJsConfig(config), null, 2)}\n`);
      return 0;
    }
    default:
      io.stderr.write(`Unknown config command: ${parsed.subcommand}\n`);
      return 1;
  }
}

async function runToolsCommand(parsed, io = {}) {
  const stdout = io.stdout;
  const stderr = io.stderr;
  const config = applyCliConfigOverrides(
    await loadCodexJsConfig(parsed.configPath),
    parsed
  );
  const toolRuntime = createToolRuntimeForCli(config, parsed);

  if (config.tools?.mcp?.enabled && parsed.allowMcp) {
    try {
      await toolRuntime.loadMcpTools();
    } catch (error) {
      stderr.write(`MCP discovery failed: ${error.message}\n`);
    }
  }

  const report = createToolCapabilityReport({
    config,
    runtime: toolRuntime,
    allowShell: parsed.allowShell,
    allowApplyPatchWrites: parsed.allowApplyPatch
  });

  switch (parsed.subcommand ?? "list") {
    case "list":
      stdout.write(formatToolReportText(report));
      return 0;
    case "inspect":
      if (parsed.json) {
        stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        stdout.write(formatToolReportText(report, {
          verbose: true
        }));
      }
      return 0;
    case "doctor":
      if (parsed.json) {
        stdout.write(`${JSON.stringify({
          ...report,
          findings: createToolDoctorFindings(report)
        }, null, 2)}\n`);
      } else {
        stdout.write(formatToolDoctorText(report));
      }
      return 0;
    default:
      stderr.write(`Unknown tools command: ${parsed.subcommand}\n`);
      return 1;
  }
}

async function runAppServerCommand(parsed, io = {}) {
  const stdout = io.stdout;

  switch (parsed.subcommand ?? "smoke") {
    case "smoke": {
      const config = applyCliConfigOverrides(
        await loadCodexJsConfig(parsed.configPath),
        parsed
      );
      const transport = createInProcessAppServerTransport({
        codexOptions: configToCodexOptions(config)
      });
      const initialized = await transport.send(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 1));
      const started = await transport.send(createRpcRequest(APP_SERVER_METHODS.THREAD_START, {
        cwd: config.workingDirectory ?? undefined
      }, 2));
      const turn = await transport.send(createRpcRequest(APP_SERVER_METHODS.TURN_START, {
        threadId: started.result.thread.id,
        input: parsed.prompt || "hello"
      }, 3));

      stdout.write(`${JSON.stringify({
        initialized: Boolean(initialized.result),
        threadId: started.result.thread.id,
        turnStatus: turn.result.turn.status,
        notifications: transport.notifications().length
      }, null, 2)}\n`);
      return 0;
    }
    case "stdio": {
      const config = applyCliConfigOverrides(
        await loadCodexJsConfig(parsed.configPath),
        parsed
      );
      const transport = createStdioAppServerTransport({
        codexOptions: configToCodexOptions(config),
        sessionStoreDirectory: config.sessionStoreDirectory ?? undefined,
        input: io.stdin,
        output: stdout,
        stderr: io.stderr
      });

      await transport.start();
      return 0;
    }
    default:
      io.stderr.write(`Unknown app-server command: ${parsed.subcommand}\n`);
      return 1;
  }
}

async function runThreadCommand(parsed, io = {}) {
  const stdout = io.stdout;
  const stderr = io.stderr;
  const config = applyCliConfigOverrides(
    await loadCodexJsConfig(parsed.configPath),
    parsed
  );
  const transport = createInProcessAppServerTransport({
    codexOptions: configToCodexOptions(config),
    sessionStoreDirectory: config.sessionStoreDirectory ?? undefined
  });

  await transport.send(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 1));

  switch (parsed.subcommand ?? "list") {
    case "start": {
      const response = await transport.send(createRpcRequest(APP_SERVER_METHODS.THREAD_START, {
        cwd: config.workingDirectory ?? undefined
      }, 2));
      return writeRpcResultOrError(response, {
        stdout,
        stderr
      });
    }
    case "list": {
      const response = await transport.send(createRpcRequest(APP_SERVER_METHODS.THREAD_LIST, {
        archived: parsed.archived === true,
        limit: parsed.limit,
        cursor: parsed.cursor,
        cwd: config.workingDirectory ?? undefined,
        searchTerm: parsed.searchTerm
      }, 2));
      return writeRpcResultOrError(response, {
        stdout,
        stderr
      });
    }
    case "read":
      return await runThreadIdCommand(APP_SERVER_METHODS.THREAD_READ, parsed, {
        stdout,
        stderr,
        transport,
        params: {
          includeTurns: true
        }
      });
    case "fork":
      return await runThreadIdCommand(APP_SERVER_METHODS.THREAD_FORK, parsed, {
        stdout,
        stderr,
        transport,
        params: {
          cwd: config.workingDirectory ?? undefined
        }
      });
    case "archive":
      return await runThreadIdCommand(APP_SERVER_METHODS.THREAD_ARCHIVE, parsed, {
        stdout,
        stderr,
        transport
      });
    case "unarchive":
      return await runThreadIdCommand(APP_SERVER_METHODS.THREAD_UNARCHIVE, parsed, {
        stdout,
        stderr,
        transport
      });
    case "rollback":
      return await runThreadIdCommand(APP_SERVER_METHODS.THREAD_ROLLBACK, parsed, {
        stdout,
        stderr,
        transport,
        params: {
          dropLastTurns: parsed.dropLastTurns
        }
      });
    case "metadata": {
      let metadata = {};

      try {
        metadata = parsed.metadata ? JSON.parse(parsed.metadata) : {};
      } catch (error) {
        stderr.write(`Invalid metadata JSON: ${error.message}\n`);
        return 1;
      }

      return await runThreadIdCommand(APP_SERVER_METHODS.THREAD_METADATA_UPDATE, parsed, {
        stdout,
        stderr,
        transport,
        params: {
          metadata
        }
      });
    }
    default:
      stderr.write(`Unknown thread command: ${parsed.subcommand}\n`);
      return 1;
  }
}

async function runThreadIdCommand(method, parsed, options = {}) {
  const threadId = parsed.threadId || parsed.prompt;

  if (!threadId) {
    options.stderr.write("Missing thread id.\n");
    return 1;
  }

  const response = await options.transport.send(createRpcRequest(method, {
    ...(options.params ?? {}),
    threadId
  }, 2));

  return writeRpcResultOrError(response, options);
}

function writeRpcResultOrError(response, io = {}) {
  if (response.error) {
    io.stderr.write(`${response.error.message}\n`);
    return 1;
  }

  io.stdout.write(`${JSON.stringify(response.result, null, 2)}\n`);
  return 0;
}

export function helpText() {
  return `codex-js

Usage:
  codex-js chat [initial prompt]
  codex-js exec <prompt> [--json|--json-stream]
  codex-js <prompt> [--json|--json-stream]
  codex-js config default
  codex-js config inspect [--config <path>]
  codex-js tools list
  codex-js tools inspect [--json]
  codex-js tools doctor [--json]
  codex-js thread list [--archived]
  codex-js thread start
  codex-js thread read <thread-id>
  codex-js thread fork <thread-id>
  codex-js thread archive <thread-id>
  codex-js thread unarchive <thread-id>
  codex-js thread rollback <thread-id> [--drop-last-turns <n>]
  codex-js thread metadata <thread-id> --metadata <json>
  codex-js app-server smoke [prompt]
  codex-js app-server stdio
  codex-js --help
  codex-js --version

Options:
  --json                 Emit JSONL thread events.
  --json-stream          Alias for --json.
  --config <path>        Load codex-js JSON config. Does not read .env.
  --resume <thread-id>   Resume a mock thread session.
  --cwd <path>           Set the working directory recorded for the turn.
  --session-store <path> Store sessions in a custom directory.
  --mock-response <text> Override the mock assistant response.
  --model-adapter <file> Load a local ESM model adapter module.
  --model-url <url>      POST prompts to an HTTP model adapter endpoint.
  --model-provider <name>
                         Use a built-in provider: deepseek or openai-compatible.
  --model <name>         Model name for built-in providers.
  --model-base-url <url> Base URL for OpenAI-compatible providers.
  --model-api-key <key>  API key for built-in providers. Prefer config or a local adapter.
  --model-header K=V     Add an HTTP adapter header. Repeatable.
  --model-option K=V     Pass an option to the model adapter. Repeatable.
  --model-options-json <json>
                         Merge a JSON object into model adapter options.
  --model-timeout <ms>   Set HTTP model adapter request timeout.
  --max-tool-iterations <n>
                         Maximum model/tool loop iterations before failing.
  --enable-hosted-tools  Expose hosted web_search/image_generation tools.
  --web-search-url <url> POST web_search tool requests to an HTTP provider.
  --image-generation-url <url>
                         POST image_generation tool requests to an HTTP provider.
  --hosted-tool-header K=V
                         Add a hosted tool provider header. Repeatable.
  --allow-mcp            Enable configured MCP servers and allow stdio spawn.
  --mcp-server NAME=COMMAND
                         Add an MCP stdio server. Repeatable.
  --allow-shell          Allow model-requested shell_command/exec tools.
  --allow-apply-patch    Allow model-requested apply_patch writes.
  --yes, -y              Auto-approve CLI tool prompts for this run.
  --sandbox <mode>       Sandbox mode: read-only, workspace-write, danger-full-access.
  --sandbox-read-root <path>
                         Add an allowed sandbox read root. Repeatable.
  --sandbox-write-root <path>
                         Add an allowed sandbox write root. Repeatable.
  --allow-network        Allow network according to sandbox policy.
  --block-env <name>     Block an env override key in tool commands. Repeatable.
  --allow-env <name>     If set, only allow listed env override keys. Repeatable.
  --dry-run-command <cmd> Emit command execution events without running shell.
  --thread-id <id>         Select a thread for thread subcommands.
  --archived              List archived thread sessions.
  --limit <n>             Limit paged thread output.
  --cursor <cursor>       Continue a paged thread list.
  --search <term>         Filter thread list by id, cwd, title, or last input.
  --drop-last-turns <n>   Remove recent turns from a stored thread.
  --metadata <json>       Patch stored thread metadata.

Tool commands:
  tools list              Print registered tools and exposure/status.
  tools inspect           Print verbose tool metadata.
  tools doctor            Print tool readiness and upstream-gap findings.

This first migration milestone is a standalone JavaScript runtime scaffold.
It does not read .env files or integrate with the desktop editor. Real shell
execution and patch writes require explicit tool flags.
`;
}

export function chatHelpText() {
  return `Commands:
  /help       Show this help.
  /thread     Print the current thread id.
  /clear      Start a new thread.
  /exit       Quit.
`;
}

async function packageVersion() {
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  return packageJson.version;
}

const chatExitCommands = new Set(["/exit", "/quit", ".exit", ".quit", "exit", "quit"]);
const chatHelpCommands = new Set(["/help", ".help", "help"]);

class CliApprovalGate {
  constructor(options = {}) {
    this.policy = options.policy ?? new ApprovalPolicy();
    this.stdin = options.stdin;
    this.stderr = options.stderr;
    this.autoApprove = Boolean(options.autoApprove);
    this.sessionApprovals = new Set();
  }

  async check(request) {
    const approval = this.policy.check(request);

    if (approval.decision !== APPROVAL_DECISIONS.PROMPT) {
      return approval;
    }

    if (this.autoApprove) {
      this.policy.approveForSession(approval.request);
      return this.policy.check(request);
    }

    const review = await this.promptForApproval(approval);

    if (review === APPROVAL_REVIEW_DECISIONS.APPROVED_FOR_SESSION) {
      this.policy.approveForSession(approval.request);
      return this.policy.check(request);
    }

    return {
      ...approval,
      decision: review === APPROVAL_REVIEW_DECISIONS.APPROVED
        ? APPROVAL_DECISIONS.ALLOW
        : APPROVAL_DECISIONS.FORBIDDEN
    };
  }

  async promptForApproval(approval) {
    const request = approval.request;

    if (!this.stdin?.readable || !this.stderr?.write) {
      return APPROVAL_REVIEW_DECISIONS.DENIED;
    }

    this.stderr.write(formatApprovalPrompt(request));

    const rl = createInterface({
      input: this.stdin,
      output: this.stderr,
      terminal: Boolean(this.stdin?.isTTY && this.stderr?.isTTY)
    });

    try {
      const answer = String(await rl.question("Approve? [y]es/[s]ession/[n]o: ") ?? "")
        .trim()
        .toLowerCase();

      if (answer === "y" || answer === "yes") {
        return APPROVAL_REVIEW_DECISIONS.APPROVED;
      }

      if (answer === "s" || answer === "session") {
        return APPROVAL_REVIEW_DECISIONS.APPROVED_FOR_SESSION;
      }

      return APPROVAL_REVIEW_DECISIONS.DENIED;
    } finally {
      rl.close();
    }
  }
}

function formatApprovalPrompt(request) {
  const lines = [
    "",
    "Tool approval required",
    `type: ${request.resource_type}`,
    `action: ${request.action}`,
    `subject: ${request.subject}`
  ];

  if (request.metadata?.cwd) {
    lines.push(`cwd: ${request.metadata.cwd}`);
  }

  if (request.metadata?.patch) {
    lines.push("patch:");
    lines.push(request.metadata.patch);
  }

  return `${lines.join("\n")}\n`;
}

function parseKeyValueOption(raw, options = {}) {
  if (!raw || !raw.includes("=")) {
    options.errors.push(`${options.label} requires KEY=VALUE.`);
    return;
  }

  const index = raw.indexOf("=");
  const key = raw.slice(0, index).trim();
  const value = raw.slice(index + 1);

  if (!key) {
    options.errors.push(`${options.label} requires a non-empty key.`);
    return;
  }

  options.target[key] = options.parseJsonValue
    ? parseLooseJsonValue(value)
    : value;
}

function parseJsonObjectOption(raw, options = {}) {
  if (!raw) {
    options.errors.push(`${options.label} requires a JSON object.`);
    return;
  }

  try {
    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      options.errors.push(`${options.label} must be a JSON object.`);
      return;
    }

    Object.assign(options.target, parsed);
  } catch (error) {
    options.errors.push(`${options.label} is invalid JSON: ${error.message}`);
  }
}

function parsePositiveIntegerOption(raw, options = {}) {
  const value = Number(raw);

  if (!Number.isFinite(value) || value <= 0) {
    options.errors.push(`${options.label} requires a positive integer.`);
    return undefined;
  }

  return Math.trunc(value);
}

function parseLooseJsonValue(value) {
  const trimmed = String(value ?? "").trim();

  if (!trimmed) {
    return "";
  }

  if (!/^(true|false|null|-?\d|\{|\[|")/u.test(trimmed)) {
    return value;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}
