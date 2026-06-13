/**
 * 中文模块说明：src/ui/server.js
 *
 * 本地可视化工作台服务，用浏览器展示 AI 执行过程、工具调用和专家团状态。
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const workbenchPath = resolve(__dirname, "workbench.html");
const binPath = resolve(__dirname, "../../bin/codex-js.js");

/**
 * 启动 codex-js 可视化工作台。
 *
 * @param {object} options - 服务配置。
 * @param {number} [options.port] - 监听端口。
 * @param {string} [options.host] - 监听地址。
 * @param {NodeJS.WritableStream} [options.stdout] - 标准输出。
 * @returns {Promise<object>} 已启动的服务信息。
 */
export async function startCodexJsUiServer(options = {}) {
  const port = Number(options.port ?? 14518);
  const host = options.host ?? "127.0.0.1";
  const stdout = options.stdout ?? process.stdout;
  const server = createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      writeJson(response, 500, {
        error: error?.message ?? String(error)
      });
    });
  });

  await new Promise((resolveStart, rejectStart) => {
    server.once("error", rejectStart);
    server.listen(port, host, () => {
      server.off("error", rejectStart);
      resolveStart();
    });
  });

  const address = `http://${host}:${server.address().port}`;
  stdout.write(`codex-js ui running at ${address}\n`);

  return {
    server,
    address
  };
}

/**
 * 处理 UI 服务请求。
 *
 * @param {import("node:http").IncomingMessage} request - HTTP 请求。
 * @param {import("node:http").ServerResponse} response - HTTP 响应。
 * @returns {Promise<void>} 无返回值。
 */
async function handleRequest(request, response) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8"
    });
    response.end(await readFile(workbenchPath, "utf8"));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/run") {
    const payload = await readJsonBody(request);
    await streamRun(response, payload);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    writeJson(response, 200, {
      ok: true
    });
    return;
  }

  writeJson(response, 404, {
    error: "not_found"
  });
}

/**
 * 把一次 codex-js exec 运行转成 SSE 事件流。
 *
 * @param {import("node:http").ServerResponse} response - HTTP 响应。
 * @param {object} payload - 前端传入的运行参数。
 * @returns {Promise<void>} 无返回值。
 */
async function streamRun(response, payload = {}) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });

  const args = buildExecArgs(payload);
  const child = spawn(process.execPath, [binPath, ...args], {
    cwd: payload.packageDirectory ?? resolve(__dirname, "../.."),
    env: {
      ...process.env,
      ...(payload.modelApiKey ? { CODEX_JS_UI_MODEL_API_KEY: String(payload.modelApiKey) } : {})
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdoutBuffer = "";
  let stderrBuffer = "";

  writeSse(response, "meta", {
    command: `node ${binPath} ${args.map(shellQuote).join(" ")}`,
    startedAt: new Date().toISOString()
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/u);
    stdoutBuffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      try {
        writeSse(response, "codex-event", JSON.parse(line));
      } catch {
        writeSse(response, "log", {
          stream: "stdout",
          text: line
        });
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    stderrBuffer += chunk;
    const lines = stderrBuffer.split(/\r?\n/u);
    stderrBuffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.trim()) {
        writeSse(response, "log", {
          stream: "stderr",
          text: line
        });
      }
    }
  });

  child.on("error", (error) => {
    writeSse(response, "error", {
      message: error.message
    });
  });

  child.on("close", (code) => {
    if (stdoutBuffer.trim()) {
      try {
        writeSse(response, "codex-event", JSON.parse(stdoutBuffer));
      } catch {
        writeSse(response, "log", {
          stream: "stdout",
          text: stdoutBuffer
        });
      }
    }

    if (stderrBuffer.trim()) {
      writeSse(response, "log", {
        stream: "stderr",
        text: stderrBuffer
      });
    }

    writeSse(response, "done", {
      code,
      finishedAt: new Date().toISOString()
    });
    response.end();
  });

  response.on("close", () => {
    if (!child.killed) {
      child.kill();
    }
  });
}

/**
 * 根据 UI 表单组装 exec 参数。
 *
 * @param {object} payload - 前端表单数据。
 * @returns {string[]} CLI 参数。
 */
function buildExecArgs(payload = {}) {
  const prompt = String(payload.prompt ?? "").trim();

  if (!prompt) {
    throw new Error("prompt is required");
  }

  const args = ["exec", prompt, "--json"];
  pushOption(args, "--cwd", payload.cwd);
  pushOption(args, "--model-provider", payload.modelProvider);
  pushOption(args, "--model", payload.model);
  pushOption(args, "--model-base-url", payload.modelBaseUrl);
  pushOption(args, "--model-timeout", payload.modelTimeoutMs);
  pushOption(args, "--max-tool-iterations", payload.maxToolIterations);

  if (payload.expertTeam) {
    args.push("--expert-team");
  }

  if (payload.allowShell) {
    args.push("--allow-shell");
  }

  if (payload.allowApplyPatch) {
    args.push("--allow-apply-patch");
  }

  if (payload.yes) {
    args.push("--yes");
  }

  return args;
}

/**
 * 追加可选 CLI 参数。
 *
 * @param {string[]} args - 参数数组。
 * @param {string} name - 参数名。
 * @param {unknown} value - 参数值。
 * @returns {void}
 */
function pushOption(args, name, value) {
  const text = String(value ?? "").trim();

  if (text) {
    args.push(name, text);
  }
}

/**
 * 读取 JSON 请求体。
 *
 * @param {import("node:http").IncomingMessage} request - HTTP 请求。
 * @returns {Promise<object>} JSON 对象。
 */
async function readJsonBody(request) {
  let body = "";

  for await (const chunk of request) {
    body += chunk;
  }

  return body ? JSON.parse(body) : {};
}

/**
 * 写 JSON 响应。
 *
 * @param {import("node:http").ServerResponse} response - HTTP 响应。
 * @param {number} status - HTTP 状态码。
 * @param {object} payload - 响应对象。
 * @returns {void}
 */
function writeJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

/**
 * 写一条 SSE 事件。
 *
 * @param {import("node:http").ServerResponse} response - HTTP 响应。
 * @param {string} event - 事件名。
 * @param {object} payload - 事件数据。
 * @returns {void}
 */
function writeSse(response, event, payload) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * 简单格式化命令参数，便于 UI 展示。
 *
 * @param {string} value - 参数值。
 * @returns {string} 展示用参数。
 */
function shellQuote(value) {
  return /\s/u.test(value) ? JSON.stringify(value) : value;
}
