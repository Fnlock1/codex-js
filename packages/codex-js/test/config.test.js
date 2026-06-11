/**
 * 中文模块说明：test/config.test.js
 *
 * Node 内置测试套件，覆盖 codex-js 的核心运行时和工具行为。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  CONFIG_SCHEMA_VERSION,
  applyCliConfigOverrides,
  configToCodexOptions,
  createDefaultConfig,
  loadCodexJsConfig,
  normalizeCodexJsConfig
} from "../src/index.js";

test("config helpers create safe defaults", () => {
  const config = createDefaultConfig();

  assert.equal(config.schemaVersion, CONFIG_SCHEMA_VERSION);
  assert.equal(config.model.provider, "mock");
  assert.equal(config.runtime.realModelEnabled, false);
  assert.equal(config.runtime.realShellEnabled, false);
  assert.equal(config.runtime.mcpEnabled, false);
  assert.equal(config.appServer.transport, "in-process");
  assert.equal(config.tools.hosted.enabled, false);
  assert.equal(config.tools.mcp.enabled, false);
});

test("normalizeCodexJsConfig resolves paths and preserves explicit safe options", () => {
  const config = normalizeCodexJsConfig({
    workingDirectory: ".",
    sessionStoreDirectory: "sessions",
    mockResponse: "done",
    model: {
      adapterPath: "adapter.mjs",
      headers: {
        Authorization: "Bearer test"
      },
      timeoutMs: 1234,
      options: {
        temperature: 0.2
      }
    },
    runtime: {
      mcpEnabled: true
    }
  });

  assert.equal(config.workingDirectory, resolve("."));
  assert.equal(config.sessionStoreDirectory, resolve("sessions"));
  assert.equal(config.mockResponse, "done");
  assert.equal(config.model.provider, "plugin");
  assert.equal(config.model.adapterPath, resolve("adapter.mjs"));
  assert.equal(config.model.headers.Authorization, "Bearer test");
  assert.equal(config.model.timeoutMs, 1234);
  assert.equal(config.model.options.temperature, 0.2);
  assert.equal(config.runtime.mcpEnabled, true);
  assert.equal(config.runtime.realShellEnabled, false);
});

test("loadCodexJsConfig reads JSON config without env files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-js-config-"));

  try {
    const filePath = join(dir, "codex-js.json");
    await writeFile(filePath, JSON.stringify({
      mockResponse: "from config"
    }), "utf8");

    const config = await loadCodexJsConfig(filePath);

    assert.equal(config.mockResponse, "from config");
  } finally {
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
});

test("applyCliConfigOverrides and configToCodexOptions map CLI values", () => {
  const config = applyCliConfigOverrides(createDefaultConfig({
    mockResponse: "config"
  }), {
    mockResponse: "cli",
    workingDirectory: ".",
    modelUrl: "http://127.0.0.1:8787/model",
    modelHeaders: {
      "x-test": "yes"
    },
    modelOptions: {
      temperature: 0.7
    },
    modelTimeoutMs: 2500
  });
  const options = configToCodexOptions(config);

  assert.equal(config.mockResponse, "cli");
  assert.equal(config.model.provider, "http");
  assert.equal(config.model.url, "http://127.0.0.1:8787/model");
  assert.equal(config.model.headers["x-test"], "yes");
  assert.equal(config.model.options.temperature, 0.7);
  assert.equal(config.model.timeoutMs, 2500);
  assert.equal(config.tools.hosted.enabled, false);
  assert.equal(options.mockResponse, "cli");
  assert.equal(options.workingDirectory, resolve("."));
});

test("applyCliConfigOverrides maps hosted tool and MCP CLI values", () => {
  const config = applyCliConfigOverrides(createDefaultConfig(), {
    enableHostedTools: true,
    webSearchUrl: "http://127.0.0.1:8787/search",
    imageGenerationUrl: "http://127.0.0.1:8787/image",
    hostedToolHeaders: {
      Authorization: "Bearer token"
    },
    allowMcp: true,
    mcpServers: [
      "fs=node server.mjs"
    ]
  });

  assert.equal(config.tools.hosted.enabled, true);
  assert.equal(config.tools.hosted.webSearchUrl, "http://127.0.0.1:8787/search");
  assert.equal(config.tools.hosted.imageGenerationUrl, "http://127.0.0.1:8787/image");
  assert.equal(config.tools.hosted.headers.Authorization, "Bearer token");
  assert.equal(config.tools.mcp.enabled, true);
  assert.equal(config.tools.mcp.allowStdioSpawn, true);
  assert.equal(config.tools.mcp.servers[0].info.name, "fs");
  assert.equal(config.tools.mcp.servers[0].config.command, "node");
});
