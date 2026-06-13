/**
 * 中文模块说明：src/cli.js
 *
 * 命令行参数解析、运行模式选择和 CLI 编排逻辑。
 */
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
import { formatExpertAgentPrompt } from "./agents/expert-profiles.js";
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
import { startCodexJsUiServer } from "./ui/server.js";
import {
  APP_SERVER_METHODS,
  createInProcessAppServerTransport,
  createStdioAppServerTransport,
  createRpcRequest
} from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = resolve(__dirname, "../package.json");

/**
 * 执行 run cli 相关数据。
 *
 * 这是异步流程，调用方需要等待 Promise 完成。
 *
 * @param {unknown} argv - argv 参数。
 * @param {unknown} io - io 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export async function runCli(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const stdin = io.stdin ?? process.stdin;
  const parsed = parseArgs(argv);
  parsed.stdin = stdin;
  parsed.stderr = stderr;

  if (!parsed.modelApiKey) {
    parsed.modelApiKey =
      io.env?.CODEX_JS_UI_MODEL_API_KEY ??
      io.env?.CODEX_JS_MODEL_API_KEY ??
      undefined;
  }

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

  if (parsed.command === "ui") {
    return await runUiCommand(parsed, {
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

/**
 * 解析 parse args 相关数据。
 *
 * @param {unknown} argv - argv 参数。
 * @returns {unknown} 返回处理后的结果。
 */
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
    uiPort: undefined,
    uiHost: undefined,
    expertTeam: false,
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

  if (["config", "app-server", "thread", "tools", "ui"].includes(parsed.command)) {
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
      case "--ui-port":
        parsed.uiPort = parsePositiveIntegerOption(args.shift(), {
          errors: parsed.errors,
          label: "--ui-port"
        });
        break;
      case "--ui-host":
        parsed.uiHost = args.shift() ?? "";
        break;
      case "--expert-team":
      case "--experts":
        parsed.expertTeam = true;
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

/**
 * 创建 create codex for cli 相关数据。
 *
 * 这是异步流程，调用方需要等待 Promise 完成。
 *
 * @param {unknown} config - config 参数。
 * @param {unknown} parsed - parsed 参数。
 * @returns {unknown} 返回处理后的结果。
 */
async function createCodexForCli(config, parsed) {
  const modelClient = await createModelClientForCli(config, parsed);
  const options = {
    ...configToCodexOptions(config),
    toolVisibility: {
      expertTeam: parsed.expertTeam
    }
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

/**
 * 创建 create tool runtime for cli 相关数据。
 *
 * @param {unknown} config - config 参数。
 * @param {unknown} parsed - parsed 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
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
    imageGenerationProvider,
    memoryStoreDirectory: config.memoryStoreDirectory ?? undefined
  });

  agentCoordinator.runner = async (agent) => {
    const expertId = agent.metadata?.expert?.id ?? agent.metadata?.expert_id ?? null;
    const runtime = new LoopingTurnRuntime({
      modelClient: options.modelClient,
      toolRuntime,
      maxToolIterations: parsed.maxToolIterations ?? config.runtime?.subAgentMaxToolIterations ?? 3
    });
    const codex = new Codex({
      workingDirectory,
      sessionStoreDirectory: config.sessionStoreDirectory ?? undefined,
      memoryStoreDirectory: config.memoryStoreDirectory ?? undefined,
      memory: {
        expertId
      },
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

/**
 * 格式化 format sub agent prompt 相关数据。
 *
 * @param {unknown} agent - agent 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function formatSubAgentPrompt(agent) {
  return formatExpertAgentPrompt(agent);
}

/**
 * 创建 create model client for cli 相关数据。
 *
 * 这是异步流程，调用方需要等待 Promise 完成。
 *
 * @param {unknown} config - config 参数。
 * @returns {unknown} 返回处理后的结果。
 */
async function createModelClientForCli(config, parsed = {}) {
  const provider = parsedProvider(config);
  const modelOptions = parsed.expertTeam
    ? {
        ...config.model.options,
        systemPrompt: mergeSystemPrompts(
          config.model.options.systemPrompt ?? config.model.options.system_prompt,
          expertTeamLeaderSystemPrompt()
        )
      }
    : config.model.options;

  if (config.model.provider === "plugin" || config.model.adapterPath) {
    if (!config.model.adapterPath) {
      throw new Error("Model provider 'plugin' requires model.adapterPath or --model-adapter.");
    }

    return await createPluginModelClient({
      modulePath: resolve(config.model.adapterPath),
      adapterOptions: modelOptions
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
      sessionOptions: modelOptions
    });
  }

  if (provider === "deepseek") {
    return createDeepSeekModelClient({
      ...modelOptions,
      apiKey: modelOptions.apiKey ?? modelOptions.api_key,
      model: modelOptions.model ?? "deepseek-v4-pro",
      baseUrl: modelOptions.baseUrl ?? modelOptions.base_url,
      headers: config.model.headers,
      timeoutMs: config.model.timeoutMs
    });
  }

  if (provider === "openai-compatible") {
    return createOpenAICompatibleModelClient({
      ...modelOptions,
      apiKey: modelOptions.apiKey ?? modelOptions.api_key,
      model: modelOptions.model,
      baseUrl: modelOptions.baseUrl ?? modelOptions.base_url,
      headers: config.model.headers,
      timeoutMs: config.model.timeoutMs
    });
  }

  return null;
}

/**
 * 合并用户已有 system prompt 和专家团技术 Leader prompt。
 *
 * @param {unknown} basePrompt - 用户或配置里的 system prompt。
 * @param {string} extraPrompt - 需要追加的专家团 prompt。
 * @returns {string} 合并后的 system prompt。
 */
function mergeSystemPrompts(basePrompt, extraPrompt) {
  return [
    basePrompt ? String(basePrompt) : "",
    extraPrompt
  ].filter(Boolean).join("\n\n");
}

/**
 * 生成专家团模式的技术 Leader 系统提示。
 *
 * 默认 chat/exec 不会使用这段提示，只有显式传入 --expert-team 或 --experts
 * 时才启用。这里要求主模型先做调度，再让专家分工输出报告。
 *
 * @returns {string} 技术 Leader 系统提示。
 */
export function expertTeamLeaderSystemPrompt() {
  return [
    "你现在是技术 Leader，也是专家团调度员。只有当前会话显式启用了专家团模式，所以你必须用多专家协作完成复杂任务。",
    "你的第一步是判断任务需要哪些专家。优先使用已有专家 id：architect、tester、frontend、security、performance、memory、tools、general。",
    "如果任务需要新的专业角色，你可以在 plan_experts 的 custom_experts / customExperts 参数里动态创建专家。动态专家的 prompt 必须由你根据当前任务即时生成，不能依赖代码里的固定模板。每个动态专家必须包含 id、name、role、description、prompt、instructions、keywords。",
    "动态专家 prompt 要完整描述该专家的专业边界、思考方式、输入假设、禁止事项、输出格式和本任务关注点。",
    "专家团流程：先调用 plan_experts 生成专家计划，再按计划调用 spawn_agent 派出专家，再调用 wait_agent 等待专家结果，最后由你综合结论并执行必要修改。",
    "每个专家都有自己的独立长期记忆。专家只能使用自己的专家私有记忆和共享 project/user 记忆；不同专家之间不得互相通信、不得互相读取私有记忆。",
    "如果子专家报告里提出问题，你必须先作为技术 Leader 判断并补充上下文；只有你仍然拿不准、且会影响最终结果时，才向用户提一个明确问题。",
    "禁止让子专家直接问用户。禁止让子专家联系其他子专家。所有跨专家协调只能由技术 Leader 完成。",
    "不要把专家报告原样堆给用户。最终只输出中文摘要、关键文件路径、验证结果和需要用户知道的风险。",
    "如果任务很小、不需要专家团，也要简短说明你作为技术 Leader 判断无需拆分，然后直接完成。"
  ].join("\n");
}

/**
 * 解析 parsed provider 相关数据。
 *
 * @param {unknown} config - config 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function parsedProvider(config) {
  return String(config.model.provider ?? "").toLowerCase();
}

/**
 * 执行 run chat command 相关数据。
 *
 * 这是异步流程，调用方需要等待 Promise 完成。
 *
 * @param {unknown} parsed - parsed 参数。
 * @param {unknown} io - io 参数。
 * @returns {unknown} 返回处理后的结果。
 */
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

/**
 * 执行 run chat prompt 相关数据。
 *
 * 这是异步流程，调用方需要等待 Promise 完成。
 *
 * @param {unknown} thread - thread 参数。
 * @param {unknown} prompt - prompt 参数。
 * @param {unknown} parsed - parsed 参数。
 * @param {unknown} io - io 参数。
 * @returns {unknown} 返回处理后的结果。
 */
async function runChatPrompt(thread, prompt, parsed, io = {}) {
  const streamed = await thread.runStreamed(prompt);
  await processEventStream(streamed.events, createExecEventProcessor({
    json: parsed.json,
    stdout: io.stdout,
    stderr: parsed.json ? io.stderr : io.stdout
  }));
}

/**
 * 执行 run config command 相关数据。
 *
 * 这是异步流程，调用方需要等待 Promise 完成。
 *
 * @param {unknown} parsed - parsed 参数。
 * @param {unknown} io - io 参数。
 * @returns {unknown} 返回处理后的结果。
 */
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

/**
 * 执行 run tools command 相关数据。
 *
 * 这是异步流程，调用方需要等待 Promise 完成。
 *
 * @param {unknown} parsed - parsed 参数。
 * @param {unknown} io - io 参数。
 * @returns {unknown} 返回处理后的结果。
 */
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

/**
 * 执行 run app server command 相关数据。
 *
 * 这是异步流程，调用方需要等待 Promise 完成。
 *
 * @param {unknown} parsed - parsed 参数。
 * @param {unknown} io - io 参数。
 * @returns {unknown} 返回处理后的结果。
 */
async function runUiCommand(parsed, io = {}) {
  await startCodexJsUiServer({
    port: parsed.uiPort,
    host: parsed.uiHost,
    stdout: io.stdout
  });

  await new Promise(() => {});
  return 0;
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

/**
 * 执行 run thread command 相关数据。
 *
 * 这是异步流程，调用方需要等待 Promise 完成。
 *
 * @param {unknown} parsed - parsed 参数。
 * @param {unknown} io - io 参数。
 * @returns {unknown} 返回处理后的结果。
 */
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

/**
 * 执行 run thread id command 相关数据。
 *
 * 这是异步流程，调用方需要等待 Promise 完成。
 *
 * @param {unknown} method - method 参数。
 * @param {unknown} parsed - parsed 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
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

/**
 * 写入 write rpc result or error 相关数据。
 *
 * @param {unknown} response - response 参数。
 * @param {unknown} io - io 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function writeRpcResultOrError(response, io = {}) {
  if (response.error) {
    io.stderr.write(`${response.error.message}\n`);
    return 1;
  }

  io.stdout.write(`${JSON.stringify(response.result, null, 2)}\n`);
  return 0;
}

/**
 * 处理 help text 相关逻辑。
 * @returns {unknown} 返回处理后的结果。
 */
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
  codex-js ui [--ui-port <port>]
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
  --ui-port <port>       Port for the browser UI. Default: 14518.
  --ui-host <host>       Host for the browser UI. Default: 127.0.0.1.
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

/**
 * 处理 chat help text 相关逻辑。
 * @returns {unknown} 返回处理后的结果。
 */
export function chatHelpText() {
  return `Commands:
  /help       Show this help.
  /thread     Print the current thread id.
  /clear      Start a new thread.
  /exit       Quit.
`;
}

/**
 * 处理 package version 相关逻辑。
 *
 * 这是异步流程，调用方需要等待 Promise 完成。
 * @returns {unknown} 返回处理后的结果。
 */
async function packageVersion() {
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  return packageJson.version;
}

const chatExitCommands = new Set(["/exit", "/quit", ".exit", ".quit", "exit", "quit"]);
const chatHelpCommands = new Set(["/help", ".help", "help"]);

/**
 * 定义 CliApprovalGate 类，封装当前模块的状态和行为。
 */
class CliApprovalGate {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} options - options 参数。
   */
  constructor(options = {}) {
    this.policy = options.policy ?? new ApprovalPolicy();
    this.stdin = options.stdin;
    this.stderr = options.stderr;
    this.autoApprove = Boolean(options.autoApprove);
    this.sessionApprovals = new Set();
  }

  /**
   * 处理 check 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} request - request 参数。
   * @returns {unknown} 返回处理后的结果。
   */
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

  /**
   * 处理 prompt for approval 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} approval - approval 参数。
   * @returns {unknown} 返回处理后的结果。
   */
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

/**
 * 格式化 format approval prompt 相关数据。
 *
 * @param {unknown} request - request 参数。
 * @returns {unknown} 返回处理后的结果。
 */
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

/**
 * 解析 parse key value option 相关数据。
 *
 * @param {unknown} raw - raw 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
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

/**
 * 解析 parse json object option 相关数据。
 *
 * @param {unknown} raw - raw 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
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

/**
 * 解析 parse positive integer option 相关数据。
 *
 * @param {unknown} raw - raw 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function parsePositiveIntegerOption(raw, options = {}) {
  const value = Number(raw);

  if (!Number.isFinite(value) || value <= 0) {
    options.errors.push(`${options.label} requires a positive integer.`);
    return undefined;
  }

  return Math.trunc(value);
}

/**
 * 解析 parse loose json value 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
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
