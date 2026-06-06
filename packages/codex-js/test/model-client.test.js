import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  HttpModelClient,
  MODEL_RESPONSE_ITEM_TYPES,
  MockModelClient,
  ModelClientSession,
  OpenAICompatibleModelClient,
  PluginModelClient,
  chatCompletionToolsFromModelTools,
  createDeepSeekModelClient,
  createScriptedModelClient,
  createModelPrompt,
  createModelResponseItem,
  defaultCodexJsSystemPrompt,
  normalizeModelResponseItemType,
  normalizeDeepSeekModelName,
  normalizeToolJsonSchema,
  createTurnContext
} from "../src/index.js";

test("createModelPrompt maps TurnContext into model input", () => {
  const context = createTurnContext({
    input: "hello",
    workingDirectory: "/workspace"
  });
  const prompt = createModelPrompt(context);

  assert.equal(prompt.inputText, "hello");
  assert.equal(prompt.threadId, context.threadId);
  assert.deepEqual(prompt.tools, []);
  assert.equal(prompt.parallelToolCalls, false);
});

test("createModelResponseItem creates assistant message response items", () => {
  const item = createModelResponseItem({
    text: "hello"
  });

  assert.equal(item.type, MODEL_RESPONSE_ITEM_TYPES.ASSISTANT_MESSAGE);
  assert.equal(item.text, "hello");
  assert.equal(item.raw, null);
});

test("createModelResponseItem creates tool call response items", () => {
  const item = createModelResponseItem({
    type: MODEL_RESPONSE_ITEM_TYPES.TOOL_CALL,
    callId: "call-1",
    name: "apply_patch",
    arguments: {
      patch: "noop"
    }
  });

  assert.equal(item.type, MODEL_RESPONSE_ITEM_TYPES.TOOL_CALL);
  assert.equal(item.call_id, "call-1");
  assert.equal(item.name, "apply_patch");
  assert.deepEqual(item.arguments, {
    patch: "noop"
  });
});

test("createModelResponseItem maps function call response items to tool calls", () => {
  const item = createModelResponseItem({
    type: MODEL_RESPONSE_ITEM_TYPES.FUNCTION_CALL,
    callId: "call-1",
    name: "shell_command",
    arguments: {
      command: "npm test"
    }
  });

  assert.equal(item.type, MODEL_RESPONSE_ITEM_TYPES.TOOL_CALL);
  assert.equal(item.call_id, "call-1");
  assert.equal(item.name, "shell_command");
  assert.equal(item.arguments, "{\"command\":\"npm test\"}");
});

test("createModelResponseItem maps custom tool call response items to tool calls", () => {
  const item = createModelResponseItem({
    type: MODEL_RESPONSE_ITEM_TYPES.CUSTOM_TOOL_CALL,
    callId: "call-1",
    name: "apply_patch",
    input: "patch"
  });

  assert.equal(item.type, MODEL_RESPONSE_ITEM_TYPES.TOOL_CALL);
  assert.equal(item.call_id, "call-1");
  assert.equal(item.name, "apply_patch");
  assert.equal(item.arguments, "patch");
  assert.equal(item.custom, true);
});

test("normalizeModelResponseItemType maps compatibility names", () => {
  assert.equal(normalizeModelResponseItemType("assistant_message"), "message");
  assert.equal(normalizeModelResponseItemType("tool_call"), "function_call");
  assert.equal(normalizeModelResponseItemType("custom_tool_call"), "custom_tool_call");
});

test("MockModelClient streams a mock assistant message", async () => {
  const client = new MockModelClient({
    mockResponse: "done"
  });
  const session = client.createSession();
  const items = [];

  for await (const item of session.streamResponse({
    inputText: "hello"
  })) {
    items.push(item);
  }

  assert.equal(items.length, 1);
  assert.equal(items[0].text, "done");
});

test("MockModelClient streams scripted responses and records prompts", async () => {
  const client = createScriptedModelClient([
    [
      {
        type: "function_call",
        callId: "call-1",
        name: "test_tool",
        arguments: {
          value: 1
        }
      }
    ],
    [
      {
        text: "done"
      }
    ]
  ]);
  const session = client.createSession();
  const first = [];
  const second = [];

  for await (const item of session.streamResponse({
    inputText: "hello",
    responseInputItems: []
  })) {
    first.push(item);
  }

  for await (const item of session.streamResponse({
    inputText: "hello",
    responseInputItems: [
      {
        type: "function_call_output",
        call_id: "call-1"
      }
    ]
  })) {
    second.push(item);
  }

  assert.equal(first[0].type, MODEL_RESPONSE_ITEM_TYPES.TOOL_CALL);
  assert.equal(first[0].call_id, "call-1");
  assert.equal(second[0].text, "done");
  assert.equal(session.prompts.length, 2);
  assert.equal(session.prompts[1].responseInputItems[0].type, "function_call_output");
  assert.equal(client.lastSession, session);
});

test("PluginModelClient loads a local ESM adapter module", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-js-model-adapter-"));

  try {
    const adapterPath = join(dir, "adapter.mjs");
    await writeFile(adapterPath, `
export default function generate(prompt) {
  return { text: "plugin says " + prompt.inputText };
}
`, "utf8");
    const client = await PluginModelClient.fromModule(adapterPath);
    const session = client.createSession();
    const items = [];

    for await (const item of session.streamResponse({
      inputText: "hello"
    })) {
      items.push(item);
    }

    assert.equal(items[0].type, MODEL_RESPONSE_ITEM_TYPES.ASSISTANT_MESSAGE);
    assert.equal(items[0].text, "plugin says hello");
  } finally {
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
});

test("PluginModelClient accepts async iterable adapter responses", async () => {
  const client = new PluginModelClient({
    adapter: {
      async *streamResponse(prompt) {
        yield "part ";
        yield {
          text: prompt.inputText
        };
      }
    }
  });
  const session = client.createSession();
  const items = [];

  for await (const item of session.streamResponse({
    inputText: "two"
  })) {
    items.push(item);
  }

  assert.equal(items.length, 2);
  assert.equal(items[0].text, "part ");
  assert.equal(items[1].text, "two");
});

test("HttpModelClient posts prompts and normalizes JSON responses", async () => {
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        body: JSON.parse(body),
        headers: request.headers
      });
      response.writeHead(200, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify({
        items: [
          {
            text: "http says " + requests[0].body.prompt.inputText
          }
        ]
      }));
    });
  });

  try {
    await listen(server);
    const { port } = server.address();
    const client = new HttpModelClient({
      url: `http://127.0.0.1:${port}/model`,
      headers: {
        "x-model": "test"
      },
      sessionOptions: {
        temperature: 0.3
      }
    });
    const session = client.createSession();
    const items = [];

    for await (const item of session.streamResponse({
      inputText: "hello"
    })) {
      items.push(item);
    }

    assert.equal(requests[0].body.prompt.inputText, "hello");
    assert.equal(requests[0].body.session.temperature, 0.3);
    assert.equal(requests[0].headers["x-model"], "test");
    assert.equal(items[0].text, "http says hello");
  } finally {
    await close(server);
  }
});

test("chatCompletionToolsFromModelTools maps function tool specs", () => {
  const tools = chatCompletionToolsFromModelTools([
    {
      type: "function",
      name: "read_file",
      description: "Read a file.",
      strict: true,
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
    },
    {
      type: "web_search",
      name: "web_search"
    }
  ]);

  assert.equal(tools.length, 1);
  assert.equal(tools[0].type, "function");
  assert.equal(tools[0].function.name, "read_file");
  assert.equal(tools[0].function.strict, true);
  assert.equal(tools[0].function.parameters.required[0], "path");
});

test("DeepSeek tool schema compatibility maps oneOf to anyOf", () => {
  const schema = normalizeToolJsonSchema({
    type: "object",
    properties: {
      command: {
        oneOf: [
          {
            type: "string"
          },
          {
            type: "array",
            items: {
              type: "string"
            }
          }
        ]
      }
    }
  }, {
    schemaCompatibility: "deepseek"
  });

  assert.equal(schema.properties.command.oneOf, undefined);
  assert.equal(schema.properties.command.anyOf.length, 2);
});

test("OpenAICompatibleModelClient posts chat completions with tools and headers", async () => {
  const requests = [];
  const fetch = async (url, request) => {
    requests.push({
      url,
      headers: request.headers,
      body: JSON.parse(request.body)
    });

    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                role: "assistant",
                reasoning_content: "think",
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: "{\"path\":\"README.md\"}"
                    }
                  }
                ],
                content: "done"
              }
            }
          ]
        };
      }
    };
  };
  const client = new OpenAICompatibleModelClient({
    baseUrl: "https://provider.example/v1",
    model: "model-a",
    apiKey: "test-key",
    temperature: 0.2,
    fetch
  });
  const session = client.createSession();
  const items = [];

  for await (const item of session.streamResponse({
    inputText: "hello",
    tools: [
      {
        type: "function",
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
      }
    ],
    responseInputItems: []
  })) {
    items.push(item);
  }

  assert.equal(requests[0].url, "https://provider.example/v1/chat/completions");
  assert.equal(requests[0].headers.authorization, "Bearer test-key");
  assert.equal(requests[0].body.model, "model-a");
  assert.equal(requests[0].body.messages[0].role, "system");
  assert.match(requests[0].body.messages[0].content, /canonical patch text/);
  assert.equal(requests[0].body.temperature, 0.2);
  assert.equal(requests[0].body.tools[0].function.name, "read_file");
  assert.equal(requests[0].body.tool_choice, "auto");
  assert.equal(items[0].type, MODEL_RESPONSE_ITEM_TYPES.REASONING);
  assert.equal(items[1].type, MODEL_RESPONSE_ITEM_TYPES.TOOL_CALL);
  assert.equal(items[1].name, "read_file");
  assert.equal(items[2].text, "done");
});

test("OpenAICompatibleModelClient sends tool output as tool messages on follow-up", async () => {
  const requests = [];
  const fetch = async (_url, request) => {
    requests.push(JSON.parse(request.body));

    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: requests.length === 1
                ? {
                    role: "assistant",
                    tool_calls: [
                      {
                        id: "call-1",
                        type: "function",
                        function: {
                          name: "read_file",
                          arguments: "{}"
                        }
                      }
                    ],
                    content: null
                  }
                : {
                    role: "assistant",
                    content: "observed"
                  }
            }
          ]
        };
      }
    };
  };
  const client = new OpenAICompatibleModelClient({
    baseUrl: "https://provider.example/v1",
    model: "model-a",
    fetch
  });
  const session = client.createSession();

  for await (const _item of session.streamResponse({
    inputText: "read",
    tools: [],
    responseInputItems: []
  })) {
    // consume
  }

  for await (const _item of session.streamResponse({
    inputText: "read",
    tools: [],
    responseInputItems: [
      {
        type: "function_call_output",
        call_id: "call-1",
        output: {
          body: "file text"
        }
      }
    ]
  })) {
    // consume
  }

  assert.equal(requests[1].messages.at(-1).role, "tool");
  assert.equal(requests[1].messages.at(-1).tool_call_id, "call-1");
  assert.equal(requests[1].messages.at(-1).content, "file text");
  assert.equal(requests[1].messages.filter((message) => message.role === "user").length, 1);
});

test("OpenAICompatibleModelClient composes custom and default system prompts", async () => {
  const requests = [];
  const client = new OpenAICompatibleModelClient({
    baseUrl: "https://provider.example/v1",
    model: "model-a",
    systemPrompt: "Custom project rule.",
    fetch: async (_url, request) => {
      requests.push(JSON.parse(request.body));

      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "done"
                }
              }
            ]
          };
        }
      };
    }
  });
  const session = client.createSession();

  for await (const _item of session.streamResponse({
    inputText: "hello",
    workingDirectory: "C:\\workspace",
    tools: [],
    responseInputItems: []
  })) {
    // consume
  }

  assert.equal(defaultCodexJsSystemPrompt().includes("apply_patch"), true);
  assert.equal(requests[0].messages[0].role, "system");
  assert.match(requests[0].messages[0].content, /Custom project rule/);
  assert.match(requests[0].messages[0].content, /Current working directory: C:\\workspace/);
});

test("OpenAICompatibleModelClient falls back to pending assistant tool call ids", async () => {
  const requests = [];
  const fetch = async (_url, request) => {
    requests.push(JSON.parse(request.body));

    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: requests.length === 1
                ? {
                    role: "assistant",
                    tool_calls: [
                      {
                        id: "call_00_deepseek",
                        type: "function",
                        function: {
                          name: "read_file",
                          arguments: "{}"
                        }
                      }
                    ],
                    content: null
                  }
                : {
                    role: "assistant",
                    content: "observed"
                  }
            }
          ]
        };
      }
    };
  };
  const client = new OpenAICompatibleModelClient({
    baseUrl: "https://provider.example/v1",
    model: "model-a",
    fetch
  });
  const session = client.createSession();

  for await (const _item of session.streamResponse({
    inputText: "read",
    tools: [],
    responseInputItems: []
  })) {
    // consume
  }

  for await (const _item of session.streamResponse({
    inputText: "read",
    tools: [],
    responseInputItems: [
      {
        type: "function_call_output",
        output: {
          body: "file text"
        }
      }
    ]
  })) {
    // consume
  }

  assert.equal(requests[1].messages.at(-1).role, "tool");
  assert.equal(requests[1].messages.at(-1).tool_call_id, "call_00_deepseek");
});

test("OpenAICompatibleModelClient sends only new tool outputs after multi-step tool loops", async () => {
  const requests = [];
  const fetch = async (_url, request) => {
    requests.push(JSON.parse(request.body));

    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: requests.length === 1
                ? {
                    role: "assistant",
                    tool_calls: [
                      {
                        id: "call-1",
                        type: "function",
                        function: {
                          name: "list_files",
                          arguments: "{}"
                        }
                      }
                    ],
                    content: null
                  }
                : requests.length === 2
                  ? {
                      role: "assistant",
                      tool_calls: [
                        {
                          id: "call-2",
                          type: "function",
                          function: {
                            name: "read_file",
                            arguments: "{}"
                          }
                        }
                      ],
                      content: null
                    }
                  : {
                      role: "assistant",
                      content: "done"
                    }
            }
          ]
        };
      }
    };
  };
  const client = new OpenAICompatibleModelClient({
    baseUrl: "https://provider.example/v1",
    model: "model-a",
    fetch
  });
  const session = client.createSession();

  for await (const _item of session.streamResponse({
    inputText: "inspect",
    tools: [],
    responseInputItems: []
  })) {
    // consume
  }

  for await (const _item of session.streamResponse({
    inputText: "inspect",
    tools: [],
    responseInputItems: [
      {
        type: "function_call_output",
        call_id: "call-1",
        output: {
          body: "files"
        }
      }
    ]
  })) {
    // consume
  }

  for await (const _item of session.streamResponse({
    inputText: "inspect",
    tools: [],
    responseInputItems: [
      {
        type: "function_call_output",
        call_id: "call-1",
        output: {
          body: "files"
        }
      },
      {
        type: "function_call_output",
        call_id: "call-2",
        output: {
          body: "file text"
        }
      }
    ]
  })) {
    // consume
  }

  assert.equal(requests[2].messages.at(-1).role, "tool");
  assert.equal(requests[2].messages.at(-1).tool_call_id, "call-2");
  assert.equal(
    requests[2].messages.filter((message) => message.role === "tool" && message.tool_call_id === "call-1").length,
    1
  );
  assert.equal(
    requests[2].messages.filter((message) => message.role === "tool" && message.tool_call_id === "call-2").length,
    1
  );
});

test("OpenAICompatibleModelClient omits unmatched empty tool output ids", async () => {
  const requests = [];
  const fetch = async (_url, request) => {
    requests.push(JSON.parse(request.body));

    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                role: "assistant",
                content: "done"
              }
            }
          ]
        };
      }
    };
  };
  const client = new OpenAICompatibleModelClient({
    baseUrl: "https://provider.example/v1",
    model: "model-a",
    fetch
  });
  const session = client.createSession();

  for await (const _item of session.streamResponse({
    inputText: "read",
    tools: [],
    responseInputItems: [
      {
        type: "function_call_output",
        output: "orphan"
      }
    ]
  })) {
    // consume
  }

  assert.equal(requests[0].messages.some((message) => message.role === "tool"), false);
});

test("OpenAICompatibleModelClient includes redacted provider error body", async () => {
  const client = new OpenAICompatibleModelClient({
    baseUrl: "https://provider.example/v1",
    model: "model-a",
    fetch: async () => ({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      async text() {
        return `{"error":{"message":"bad key ${"sk-" + "testsecret"} and bad schema"}}`;
      }
    })
  });
  const session = client.createSession();

  await assert.rejects(
    async () => {
      for await (const _item of session.streamResponse({
        inputText: "hello",
        tools: [],
        responseInputItems: []
      })) {
        // consume
      }
    },
    /400 Bad Request: .*sk-\[redacted\].*bad schema/
  );
});

test("OpenAICompatibleModelClient reports fetch aborts as model timeouts", async () => {
  const client = new OpenAICompatibleModelClient({
    baseUrl: "https://provider.example/v1",
    model: "model-a",
    timeoutMs: 1,
    fetch: async (_url, request) => {
      await new Promise((resolve, reject) => {
        request.signal.addEventListener("abort", () => {
          reject(new DOMException("This operation was aborted", "AbortError"));
        }, {
          once: true
        });
      });
    }
  });
  const session = client.createSession();

  await assert.rejects(
    async () => {
      for await (const _item of session.streamResponse({
        inputText: "hello",
        tools: [],
        responseInputItems: []
      })) {
        // consume
      }
    },
    /model endpoint timed out after 1ms/
  );
});

test("createDeepSeekModelClient uses DeepSeek defaults without hardcoded secrets", () => {
  const client = createDeepSeekModelClient({
    apiKey: "runtime-key"
  });

  assert.equal(client.baseUrl, "https://api.deepseek.com");
  assert.equal(client.model, "deepseek-v4-pro");
  assert.equal(client.apiKey, "runtime-key");
  assert.equal(client.timeoutMs, 180000);
  assert.equal(normalizeDeepSeekModelName("v4-pro"), "deepseek-v4-pro");
});

test("ModelClientSession base class requires implementation", async () => {
  const session = new ModelClientSession();

  await assert.rejects(
    async () => {
      for await (const _item of session.streamResponse({ inputText: "hello" })) {
        // unreachable
      }
    },
    /must be implemented/
  );
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
}

function close(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
