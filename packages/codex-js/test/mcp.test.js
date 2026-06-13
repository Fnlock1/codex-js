/**
 * 中文模块说明：test/mcp.test.js
 *
 * Node 内置测试套件，覆盖 codex-js 的核心运行时和工具行为。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  McpResourceToolHandler,
  McpRuntime,
  McpServerRegistry,
  ManagedMcpClient,
  StdioMcpClient,
  SafeToolCallRuntime,
  ApprovalGate,
  ApprovalPolicy,
  APPROVAL_DECISIONS,
  StaticMcpClient,
  MCP_SERVER_STATUSES,
  TOOL_CALL_RESULT_STATUSES,
  createMcpCallToolResult,
  createManagedMcpClient,
  createMcpTextContent,
  createMcpToolName,
  createMcpToolSpec,
  createStdioMcpClient,
  createToolCallRequest,
  mcpCallToolResultToText,
  normalizeMcpResource,
  normalizeMcpResourceTemplate,
  normalizeMcpServerInfo,
  normalizeMcpTool,
  parseMcpToolName
} from "../src/index.js";

test("MCP protocol helpers normalize server, tool, and resource shapes", () => {
  assert.deepEqual(normalizeMcpServerInfo({
    name: "fs",
    version: "1.0.0",
    websiteUrl: "https://example.test"
  }), {
    name: "fs",
    title: null,
    version: "1.0.0",
    description: null,
    icons: null,
    website_url: "https://example.test"
  });
  assert.equal(normalizeMcpTool({
    name: "read",
    inputSchema: {
      type: "object"
    }
  }).input_schema.type, "object");
  assert.equal(normalizeMcpResource({
    name: "big",
    uri: "file:///big",
    size: 10
  }).size, 10);
  assert.equal(normalizeMcpResourceTemplate({
    name: "file",
    uriTemplate: "file:///{path}"
  }).uri_template, "file:///{path}");
});

test("MCP tool names round-trip with the Codex legacy prefix", () => {
  const name = createMcpToolName("file server", "read_file");

  assert.equal(name, "mcp__file_server__read_file");
  assert.deepEqual(parseMcpToolName(name), {
    server: "file_server",
    tool: "read_file"
  });
  assert.equal(parseMcpToolName("read_file"), null);
});

test("MCP tool specs preserve server and schema metadata", () => {
  const spec = createMcpToolSpec({
    server: "fs",
    tool: {
      name: "read",
      description: "Read file",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string"
          }
        }
      }
    },
    namespaceDescription: "Filesystem tools"
  });

  assert.equal(spec.name, "mcp__fs__read");
  assert.equal(spec.mcp_server, "fs");
  assert.equal(spec.mcp_tool, "read");
  assert.match(spec.description, /Read file/);
  assert.equal(spec.parameters.properties.path.type, "string");
});

test("MCP call tool results extract readable text", () => {
  const result = createMcpCallToolResult({
    content: [
      createMcpTextContent("hello")
    ],
    structuredContent: {
      ok: true
    }
  });

  assert.equal(mcpCallToolResultToText(result), "hello\n{\"ok\":true}");
});

test("StaticMcpClient lists resources and calls scripted tools", async () => {
  const client = new StaticMcpClient({
    servers: [
      {
        info: {
          name: "fs",
          version: "1"
        },
        tools: [
          {
            name: "read",
            inputSchema: {
              type: "object"
            }
          }
        ],
        resources: [
          {
            name: "README",
            uri: "file:///README.md"
          }
        ],
        resourceTemplates: [
          {
            name: "file",
            uriTemplate: "file:///{path}"
          }
        ],
        resourceContents: {
          "file:///README.md": {
            uri: "file:///README.md",
            text: "hello"
          }
        },
        toolResults: {
          read: {
            content: [
              {
                type: "text",
                text: "read ok"
              }
            ]
          }
        }
      }
    ]
  });

  assert.deepEqual((await client.listServers()).map((server) => server.name), ["fs"]);
  assert.deepEqual((await client.listTools("fs")).map((tool) => tool.name), ["read"]);
  assert.equal((await client.listResources({
    server: "fs"
  })).resources[0].uri, "file:///README.md");
  assert.equal((await client.listResourceTemplates({
    server: "fs"
  })).resource_templates[0].uri_template, "file:///{path}");
  assert.equal((await client.readResource({
    server: "fs",
    uri: "file:///README.md"
  })).contents[0].text, "hello");
  assert.equal(mcpCallToolResultToText(await client.callTool({
    server: "fs",
    tool: "read"
  })), "read ok");
});

test("McpServerRegistry registers servers and tracks connection status", () => {
  const registry = new McpServerRegistry();
  const server = registry.register({
    info: {
      name: "fs",
      version: "1"
    },
    config: {
      command: "node",
      args: ["server.js"]
    }
  });

  assert.equal(server.status, MCP_SERVER_STATUSES.DISCONNECTED);
  assert.equal(registry.has("fs"), true);
  assert.throws(
    () => registry.register({
      info: {
        name: "fs",
        version: "1"
      }
    }),
    /already registered/
  );

  const updated = registry.setStatus("fs", MCP_SERVER_STATUSES.CONNECTED);

  assert.equal(updated.status, MCP_SERVER_STATUSES.CONNECTED);
  assert.deepEqual(registry.listServerInfo().map((info) => info.name), ["fs"]);
});

test("ManagedMcpClient discovers configured servers without spawning processes", async () => {
  const client = createManagedMcpClient({
    servers: [
      {
        info: {
          name: "fs",
          version: "1"
        },
        tools: [
          {
            name: "read",
            inputSchema: {
              type: "object"
            }
          }
        ],
        resources: [
          {
            name: "README",
            uri: "file:///README.md"
          }
        ],
        resourceContents: {
          "file:///README.md": {
            uri: "file:///README.md",
            text: "hello"
          }
        },
        toolResults: {
          read: {
            content: [
              {
                type: "text",
                text: "read ok"
              }
            ]
          }
        }
      }
    ]
  });

  assert.ok(client instanceof ManagedMcpClient);
  assert.equal((await client.listServerStatuses())[0].status, MCP_SERVER_STATUSES.DISCONNECTED);
  await client.refreshAll();
  assert.equal((await client.listServerStatuses())[0].status, MCP_SERVER_STATUSES.CONNECTED);
  assert.equal((await client.listTools("fs"))[0].name, "read");
  assert.equal((await client.readResource({
    server: "fs",
    uri: "file:///README.md"
  })).contents[0].text, "hello");
  assert.equal(mcpCallToolResultToText(await client.callTool({
    server: "fs",
    tool: "read"
  })), "read ok");
});

test("StdioMcpClient is blocked by default and can round-trip with an explicit stdio server", async () => {
  const blocked = createStdioMcpClient({
    name: "blocked",
    command: process.execPath,
    args: ["-e", ""]
  });

  assert.ok(blocked instanceof StdioMcpClient);
  await assert.rejects(
    () => blocked.listServers(),
    /spawn is blocked/
  );

  const dir = await mkdtemp(join(tmpdir(), "codex-js-mcp-stdio-"));

  try {
    const serverPath = join(dir, "server.mjs");
    await writeFile(serverPath, `
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });

for await (const line of rl) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  if (message.id == null) continue;

  let result = {};
  if (message.method === "initialize") {
    result = { protocolVersion: "2025-06-18", serverInfo: { name: "stdio", version: "1" }, capabilities: {} };
  } else if (message.method === "tools/list") {
    result = { tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object" } }] };
  } else if (message.method === "tools/call") {
    result = { content: [{ type: "text", text: "echo:" + (message.params.arguments?.text ?? "") }] };
  } else if (message.method === "resources/list") {
    result = { resources: [{ name: "README", uri: "file:///README.md" }] };
  } else if (message.method === "resources/templates/list") {
    result = { resourceTemplates: [{ name: "file", uriTemplate: "file:///{path}" }] };
  } else if (message.method === "resources/read") {
    result = { contents: [{ uri: message.params.uri, text: "hello resource" }] };
  }

  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
}
`, "utf8");

    const client = createStdioMcpClient({
      name: "stdio",
      command: process.execPath,
      args: [serverPath],
      allowSpawn: true,
      defaultTimeoutMs: 5000
    });

    assert.equal((await client.listServers())[0].name, "stdio");
    assert.equal((await client.listTools("stdio"))[0].name, "echo");
    assert.equal(mcpCallToolResultToText(await client.callTool({
      server: "stdio",
      tool: "echo",
      arguments: {
        text: "hello"
      }
    })), "echo:hello");
    assert.equal((await client.listResources({
      server: "stdio"
    })).resources[0].uri, "file:///README.md");
    assert.equal((await client.listResourceTemplates({
      server: "stdio"
    })).resource_templates[0].uri_template, "file:///{path}");
    assert.equal((await client.readResource({
      server: "stdio",
      uri: "file:///README.md"
    })).contents[0].text, "hello resource");

    await client.close();
  } finally {
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
});

test("ManagedMcpClient keeps stdio process spawning blocked unless explicitly enabled", async () => {
  const client = createManagedMcpClient({
    servers: [
      {
        info: {
          name: "stdio",
          version: "1"
        },
        config: {
          transport: "stdio",
          command: process.execPath,
          args: ["-e", ""]
        }
      }
    ]
  });

  const [status] = await client.refreshAll();

  assert.equal(status.status, MCP_SERVER_STATUSES.FAILED);
  assert.match(status.error, /spawn is blocked/);
  assert.equal(client.clients.size, 0);
});

test("ManagedMcpClient can refresh and use an explicitly allowed stdio server", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-js-managed-mcp-stdio-"));

  try {
    const serverPath = join(dir, "server.mjs");
    await writeFile(serverPath, createStdioMcpTestServerSource({
      serverName: "managed",
      toolTextPrefix: "managed:"
    }), "utf8");

    const client = createManagedMcpClient({
      allowStdioSpawn: true,
      servers: [
        {
          info: {
            name: "managed",
            version: "0"
          },
          config: {
            transport: "stdio",
            command: process.execPath,
            args: [serverPath]
          }
        }
      ]
    });

    const [status] = await client.refreshAll();

    assert.equal(status.status, MCP_SERVER_STATUSES.CONNECTED);
    assert.equal((await client.listServerStatuses())[0].version, "1");
    assert.equal((await client.listTools("managed"))[0].name, "echo");
    assert.equal(mcpCallToolResultToText(await client.callTool({
      server: "managed",
      tool: "echo",
      arguments: {
        text: "hello"
      }
    })), "managed:hello");
    assert.equal((await client.listResources({
      server: "managed"
    })).resources[0].uri, "file:///README.md");
    assert.equal((await client.readResource({
      server: "managed",
      uri: "file:///README.md"
    })).contents[0].text, "hello resource");

    await client.closeAll();
    assert.equal(client.clients.size, 0);
  } finally {
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
});

test("McpRuntime creates dynamic tool definitions and calls tools", async () => {
  const runtime = new McpRuntime({
    client: new StaticMcpClient({
      servers: [
        {
          info: {
            name: "fs",
            version: "1",
            description: "Filesystem tools"
          },
          tools: [
            {
              name: "read",
              inputSchema: {
                type: "object"
              }
            }
          ],
          toolResults: {
            read: {
              content: [
                {
                  type: "text",
                  text: "read ok"
                }
              ]
            }
          }
        }
      ]
    })
  });
  const definitions = await runtime.createToolDefinitions();

  assert.equal(definitions[0].name, "mcp__fs__read");
  const result = await definitions[0].handler.run(createToolCallRequest({
    callId: "call-1",
    name: "mcp__fs__read",
    arguments: {
      path: "README.md"
    }
  }));

  assert.equal(result.status, TOOL_CALL_RESULT_STATUSES.COMPLETED);
  assert.equal(result.output, "read ok");
  assert.equal(result.raw.capability.request.resource, "mcp");
  assert.equal(result.raw.capability.request.action, "run");
  assert.equal(result.raw.capability.request.metadata.server, "fs");
  assert.equal(result.raw.capability.request.metadata.mcpTool, "read");
});

test("McpRuntime exposes discovery status and can be loaded into ToolRouter", async () => {
  const runtime = new McpRuntime({
    client: new ManagedMcpClient({
      servers: [
        {
          info: {
            name: "fs",
            version: "1"
          },
          tools: [
            {
              name: "read",
              inputSchema: {
                type: "object"
              }
            }
          ],
          toolResults: {
            read: {
              content: [
                {
                  type: "text",
                  text: "read ok"
                }
              ]
            }
          }
        }
      ]
    })
  });
  const toolRuntime = new SafeToolCallRuntime({
    mcpRuntime: runtime
  });
  const loaded = await toolRuntime.loadMcpTools();

  assert.equal((await runtime.listServerStatuses())[0].status, MCP_SERVER_STATUSES.CONNECTED);
  assert.equal(loaded[0].name, "mcp__fs__read");
  assert.equal(toolRuntime.router.has("mcp__fs__read"), true);

  const result = await toolRuntime.run(createToolCallRequest({
    callId: "call-1",
    name: "mcp__fs__read",
    arguments: {
      path: "README.md"
    }
  }));

  assert.equal(result.status, TOOL_CALL_RESULT_STATUSES.COMPLETED);
  assert.equal(result.output, "read ok");
});

test("McpRuntime dynamic tool calls honor approval gate decisions", async () => {
  const runtime = new McpRuntime({
    approvalGate: new ApprovalGate({
      policy: new ApprovalPolicy({
        defaultDecision: APPROVAL_DECISIONS.PROMPT
      })
    }),
    client: new ManagedMcpClient({
      servers: [
        {
          info: {
            name: "fs",
            version: "1"
          },
          tools: [
            {
              name: "read",
              inputSchema: {
                type: "object"
              }
            }
          ],
          toolResults: {
            read: {
              content: [
                {
                  type: "text",
                  text: "should not run"
                }
              ]
            }
          }
        }
      ]
    })
  });
  const toolRuntime = new SafeToolCallRuntime({
    mcpRuntime: runtime
  });

  await toolRuntime.loadMcpTools();

  const result = await toolRuntime.run(createToolCallRequest({
    callId: "call-1",
    name: "mcp__fs__read",
    arguments: {}
  }));

  assert.equal(result.status, TOOL_CALL_RESULT_STATUSES.FAILED);
  assert.equal(result.error, "blocked: prompt");
  assert.equal(result.raw.mcp.server, "fs");
  assert.equal(result.raw.capability.request.resource, "mcp");
  assert.equal(result.raw.capability.request.metadata.server, "fs");
  assert.equal(result.raw.capability.request.metadata.mcpTool, "read");
  assert.equal(result.raw.capability.decision, "prompt");
  assert.equal(result.raw.approval.approvalRequest.resource_type, "tool");
});

test("McpRuntime defaults to a not-connected safe failure", async () => {
  const runtime = new McpRuntime();
  const result = await runtime.callTool({
    call_id: "call-1",
    name: "mcp__fs__read",
    server: "fs",
    tool: "read",
    arguments: {}
  });

  assert.equal(result.status, TOOL_CALL_RESULT_STATUSES.FAILED);
  assert.equal(result.error, "mcp_not_connected");
});

test("McpResourceToolHandler maps resource requests through injected runtime", async () => {
  const handler = new McpResourceToolHandler({
    kind: "read_resource",
    mcpRuntime: new McpRuntime({
      client: new StaticMcpClient({
        servers: [
          {
            info: {
              name: "fs",
              version: "1"
            },
            resourceContents: {
              "file:///README.md": {
                uri: "file:///README.md",
                text: "hello"
              }
            }
          }
        ]
      })
    })
  });
  const result = await handler.run(createToolCallRequest({
    callId: "call-1",
    name: "read_mcp_resource",
    arguments: {
      server: "fs",
      uri: "file:///README.md"
    }
  }));

  assert.equal(result.status, TOOL_CALL_RESULT_STATUSES.COMPLETED);
  assert.match(result.output, /hello/);
});

/**
 * 创建 create stdio mcp test server source 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function createStdioMcpTestServerSource(options = {}) {
  const serverName = JSON.stringify(options.serverName ?? "stdio");
  const toolTextPrefix = JSON.stringify(options.toolTextPrefix ?? "echo:");

  return `
import readline from "node:readline";

const serverName = ${serverName};
const toolTextPrefix = ${toolTextPrefix};
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });

for await (const line of rl) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  if (message.id == null) continue;

  let result = {};
  if (message.method === "initialize") {
    result = { protocolVersion: "2025-06-18", serverInfo: { name: serverName, version: "1" }, capabilities: {} };
  } else if (message.method === "tools/list") {
    result = { tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object" } }] };
  } else if (message.method === "tools/call") {
    result = { content: [{ type: "text", text: toolTextPrefix + (message.params.arguments?.text ?? "") }] };
  } else if (message.method === "resources/list") {
    result = { resources: [{ name: "README", uri: "file:///README.md" }] };
  } else if (message.method === "resources/templates/list") {
    result = { resourceTemplates: [{ name: "file", uriTemplate: "file:///{path}" }] };
  } else if (message.method === "resources/read") {
    result = { contents: [{ uri: message.params.uri, text: "hello resource" }] };
  }

  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
}
`;
}
