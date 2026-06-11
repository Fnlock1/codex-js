/**
 * 中文模块说明：test/app-server.test.js
 *
 * Node 内置测试套件，覆盖 codex-js 的核心运行时和工具行为。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  APPROVAL_DECISIONS,
  APP_SERVER_ERROR_CODES,
  APP_SERVER_METHODS,
  APP_SERVER_NOTIFICATIONS,
  ApprovalGate,
  ApprovalPolicy,
  Codex,
  CodexAppServer,
  ManagedMcpClient,
  McpRuntime,
  PermissionGrantStore,
  RealCommandSessionManager,
  RealProcessRuntime,
  ServerRequestStore,
  SANDBOX_MODES,
  SandboxPolicy,
  THREAD_STATUS_TYPES,
  THREAD_GOAL_STATUSES,
  TURN_CONTROL_STATUSES,
  createAssistantMessageItem,
  createConfigVersion,
  createTurnControlRecord,
  createItemCompletedEvent,
  createCodexAppServer,
  createInProcessAppServerTransport,
  createPermissionsApprovalServerRequest,
  createRpcRequest,
  createStdioAppServerTransport,
  createTurnCompletedEvent,
  threadEventToAppServerNotification
} from "../src/index.js";

const TEST_TMP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", ".tmp-tests");

test("app-server rejects requests before initialize and rejects repeated initialize", async () => {
  const server = createCodexAppServer();

  const beforeInit = await server.handle(createRpcRequest(APP_SERVER_METHODS.THREAD_START, {}, 1));
  assert.equal(beforeInit.error.code, APP_SERVER_ERROR_CODES.NOT_INITIALIZED);

  const initialized = await server.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {
    clientInfo: {
      name: "test"
    }
  }, 2));
  assert.equal(initialized.result.userAgent, "codex-js-app-server/0.1.0");

  const again = await server.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 3));
  assert.equal(again.error.code, APP_SERVER_ERROR_CODES.ALREADY_INITIALIZED);

  const initializedNotification = await server.handle({
    method: APP_SERVER_METHODS.INITIALIZED
  });
  assert.equal(initializedNotification, null);
});

test("app-server returns protocol errors for unknown methods and missing params", async () => {
  const server = createCodexAppServer();

  await server.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 1));

  const unknown = await server.handle(createRpcRequest("missing/method", {}, 2));
  assert.equal(unknown.error.code, APP_SERVER_ERROR_CODES.METHOD_NOT_FOUND);

  const missing = await server.handle(createRpcRequest(APP_SERVER_METHODS.TURN_START, {}, 3));
  assert.equal(missing.error.code, APP_SERVER_ERROR_CODES.INVALID_PARAMS);
});

test("app-server starts threads and streams turn notifications", async () => {
  const sessionStoreDirectory = await mkdtemp(join(tmpdir(), "codex-js-app-server-"));
  const notifications = [];

  try {
    const server = new CodexAppServer({
      codex: new Codex({
        sessionStoreDirectory,
        mockResponse: "done"
      }),
      /**
       * 处理 on notification 相关逻辑。
       *
       * @param {unknown} notification - notification 参数。
       * @returns {unknown} 返回处理后的结果。
       */
      onNotification(notification) {
        notifications.push(notification);
      }
    });

    await server.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 1));

    const started = await server.handle(createRpcRequest(APP_SERVER_METHODS.THREAD_START, {
      cwd: sessionStoreDirectory
    }, 2));
    const threadId = started.result.thread.id;

    assert.equal(started.result.thread.status.type, THREAD_STATUS_TYPES.IDLE);
    assert.equal(notifications[0].method, APP_SERVER_NOTIFICATIONS.THREAD_STARTED);

    const startedList = await server.handle(createRpcRequest(APP_SERVER_METHODS.THREAD_LIST, {}, 7));
    assert.equal(startedList.result.threads.some((thread) => thread.id === threadId), true);

    const turn = await server.handle(createRpcRequest(APP_SERVER_METHODS.TURN_START, {
      threadId,
      input: "hello"
    }, 3));

    assert.equal(turn.result.turn.threadId, threadId);
    assert.equal(turn.result.turn.status, "completed");
    assert.equal(notifications.some((notification) => notification.method === APP_SERVER_NOTIFICATIONS.ITEM_COMPLETED), true);
    assert.equal(notifications.some((notification) => notification.method === APP_SERVER_NOTIFICATIONS.TURN_COMPLETED), true);

    const read = await server.handle(createRpcRequest(APP_SERVER_METHODS.THREAD_READ, {
      threadId,
      includeTurns: true
    }, 4));

    assert.equal(read.result.thread.turns.length, 1);

    await server.handle(createRpcRequest(APP_SERVER_METHODS.TURN_START, {
      threadId,
      input: "again"
    }, 5));

    const page = await server.handle(createRpcRequest(APP_SERVER_METHODS.THREAD_TURNS_LIST, {
      threadId,
      limit: 1,
      sortDirection: "desc",
      itemsView: "none"
    }, 6));

    assert.equal(page.result.turns.length, 1);
    assert.equal(page.result.turns[0].items.length, 0);
    assert.equal(typeof page.result.nextCursor, "string");
  } finally {
    await rm(sessionStoreDirectory, {
      recursive: true,
      force: true
    });
  }
});

test("app-server command/exec emits dry-run command notifications", async () => {
  const notifications = [];
  const server = new CodexAppServer({
    /**
     * 处理 on notification 相关逻辑。
     *
     * @param {unknown} notification - notification 参数。
     * @returns {unknown} 返回处理后的结果。
     */
    onNotification(notification) {
      notifications.push(notification);
    }
  });

  await server.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 1));

  const response = await server.handle(createRpcRequest(APP_SERVER_METHODS.COMMAND_EXEC, {
    command: "npm test"
  }, 2));

  assert.equal(response.result.command.status, "completed");
  assert.equal(response.result.command.dryRun, true);
  assert.match(response.result.command.output, /dry-run: npm test/);
  assert.equal(notifications.some((notification) => notification.method === APP_SERVER_NOTIFICATIONS.ITEM_STARTED), true);
  assert.equal(notifications.some((notification) => notification.method === APP_SERVER_NOTIFICATIONS.COMMAND_EXEC_OUTPUT_DELTA), true);
});

test("app-server command/exec can create a session and write stdin", async () => {
  const notifications = [];
  const server = new CodexAppServer({
    /**
     * 处理 on notification 相关逻辑。
     *
     * @param {unknown} notification - notification 参数。
     * @returns {unknown} 返回处理后的结果。
     */
    onNotification(notification) {
      notifications.push(notification);
    }
  });

  await server.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 1));

  const response = await server.handle(createRpcRequest(APP_SERVER_METHODS.COMMAND_EXEC, {
    command: "npm test",
    process_id: "proc-dry",
    stream_stdin: true
  }, 2));

  assert.equal(response.result.command.status, "completed");
  assert.equal(response.result.command.dryRun, true);
  assert.equal(response.result.command.sessionId, 1);
  assert.equal(response.result.command.processId, "proc-dry");
  assert.match(response.result.output, /session_id/);

  const write = await server.handle(createRpcRequest(APP_SERVER_METHODS.COMMAND_EXEC_WRITE, {
    process_id: "proc-dry",
    delta_base64: Buffer.from("echo hi\n").toString("base64")
  }, 3));

  assert.equal(write.result.session.session_id, 1);
  assert.equal(write.result.session.process_id, "proc-dry");
  assert.match(write.result.session.output, /stdin accepted/);
  const resize = await server.handle(createRpcRequest(APP_SERVER_METHODS.COMMAND_EXEC_RESIZE, {
    process_id: "proc-dry",
    size: {
      rows: 24,
      cols: 80
    }
  }, 4));
  assert.equal(resize.result.session.chunk_id.endsWith(":resize"), true);
  assert.equal(notifications.filter((notification) => notification.method === APP_SERVER_NOTIFICATIONS.COMMAND_EXEC_OUTPUT_DELTA).length, 2);
  assert.equal(notifications[0].params.processId, "proc-dry");
  assert.equal(typeof notifications[0].params.deltaBase64, "string");
});

test("app-server command/exec can use an injected real command session manager", async () => {
  const notifications = [];
  const server = new CodexAppServer({
    commandSessionManager: new RealCommandSessionManager({
      defaultTimeoutMs: 5000
    }),
    /**
     * 处理 on notification 相关逻辑。
     *
     * @param {unknown} notification - notification 参数。
     * @returns {unknown} 返回处理后的结果。
     */
    onNotification(notification) {
      notifications.push(notification);
    }
  });

  await server.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 1));

  const response = await server.handle(createRpcRequest(APP_SERVER_METHODS.COMMAND_EXEC, {
    processId: "real-proc",
    command: [
      process.execPath,
      "-e",
      "process.stdin.on('data', d => process.stdout.write('got:' + d)); process.stdin.on('end', () => process.stdout.write('done'))"
    ],
    stream_stdin: true
  }, 2));

  assert.equal(response.result.command.sessionId, 1);
  assert.equal(response.result.command.processId, "real-proc");
  assert.equal(response.result.session.status, "running");

  await server.handle(createRpcRequest(APP_SERVER_METHODS.COMMAND_EXEC_WRITE, {
    processId: "real-proc",
    delta_base64: Buffer.from("hello\n").toString("base64"),
    close_stdin: true
  }, 3));

  await waitForAppServerSessionOutput(server, response.result.command.sessionId, /done/);

  const polled = await server.handle(createRpcRequest(APP_SERVER_METHODS.COMMAND_EXEC_WRITE, {
    processId: "real-proc",
    chars: ""
  }, 4));

  assert.match(polled.result.session.output, /got:hello/);
  assert.match(polled.result.session.output, /done/);
  assert.equal(
    notifications.some((notification) =>
      notification.method === APP_SERVER_NOTIFICATIONS.COMMAND_EXEC_OUTPUT_DELTA &&
      notification.params.process_id === "real-proc" &&
      notification.params.stream === "stdout" &&
      Buffer.from(notification.params.delta_base64, "base64").toString("utf8").length > 0
    ),
    true
  );

  const terminated = await server.handle(createRpcRequest(APP_SERVER_METHODS.COMMAND_EXEC_TERMINATE, {
    processId: "real-proc"
  }, 5));
  assert.equal(terminated.result.session.process_id, "real-proc");
});

test("app-server command sessions reject duplicate active process ids", async () => {
  const server = new CodexAppServer({
    commandSessionManager: new RealCommandSessionManager({
      defaultTimeoutMs: 5000
    })
  });

  await server.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 1));

  const first = await server.handle(createRpcRequest(APP_SERVER_METHODS.COMMAND_EXEC, {
    processId: "dup-proc",
    command: [
      process.execPath,
      "-e",
      "setTimeout(() => {}, 500)"
    ],
    stream_stdin: true
  }, 2));
  const duplicate = await server.handle(createRpcRequest(APP_SERVER_METHODS.COMMAND_EXEC, {
    processId: "dup-proc",
    command: [
      process.execPath,
      "-e",
      "console.log('second')"
    ],
    stream_stdin: true
  }, 3));

  await server.handle(createRpcRequest(APP_SERVER_METHODS.COMMAND_EXEC_TERMINATE, {
    processId: "dup-proc"
  }, 4));

  assert.equal(first.result.session.status, "running");
  assert.equal(duplicate.error.code, APP_SERVER_ERROR_CODES.INVALID_PARAMS);
  assert.equal(duplicate.error.data.error, "duplicate_process_id");
});

test("app-server command sessions honor approval and sandbox gates", async () => {
  const approvalServer = new CodexAppServer({
    approvalGate: new ApprovalGate({
      policy: new ApprovalPolicy({
        defaultDecision: APPROVAL_DECISIONS.PROMPT
      })
    })
  });
  await approvalServer.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 1));

  const approvalBlocked = await approvalServer.handle(createRpcRequest(APP_SERVER_METHODS.COMMAND_EXEC, {
    command: "npm test",
    stream_stdin: true
  }, 2));

  assert.equal(approvalBlocked.error.code, APP_SERVER_ERROR_CODES.INVALID_PARAMS);
  assert.equal(approvalBlocked.error.data.reason, "approval_required");
  assert.equal(approvalBlocked.error.data.approval.approvalRequest.resource_type, "exec");

  const sandboxServer = new CodexAppServer({
    sandboxPolicy: new SandboxPolicy({
      mode: SANDBOX_MODES.READ_ONLY,
      workingDirectory: tmpdir()
    })
  });
  await sandboxServer.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 3));

  const sandboxBlocked = await sandboxServer.handle(createRpcRequest(APP_SERVER_METHODS.COMMAND_EXEC, {
    command: "npm test",
    cwd: tmpdir(),
    stream_stdin: true
  }, 4));

  assert.equal(sandboxBlocked.error.code, APP_SERVER_ERROR_CODES.INVALID_PARAMS);
  assert.equal(sandboxBlocked.error.data.reason, "sandbox_denied");
});

test("in-process app-server transport sends object and string messages", async () => {
  const transport = createInProcessAppServerTransport();
  const initialized = await transport.send(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 1));

  assert.equal(initialized.id, 1);

  const started = await transport.send(JSON.stringify(createRpcRequest(APP_SERVER_METHODS.THREAD_START, {}, 2)));

  assert.equal(started.id, 2);
  assert.equal(typeof started.result.thread.id, "string");
  assert.equal(transport.sent.length, 2);
  assert.equal(transport.notifications()[0].method, APP_SERVER_NOTIFICATIONS.THREAD_STARTED);
});

test("stdio app-server transport handles JSONL requests and notifications", async () => {
  const output = createWritableCapture();
  const transport = createStdioAppServerTransport({
    output
  });

  const initialized = await transport.handleLine(JSON.stringify(createRpcRequest(
    APP_SERVER_METHODS.INITIALIZE,
    {},
    1
  )));
  const started = await transport.handleLine(JSON.stringify(createRpcRequest(
    APP_SERVER_METHODS.THREAD_START,
    {},
    2
  )));
  const parseError = await transport.handleLine("{not json");
  const lines = output.text.trim().split("\n").map((line) => JSON.parse(line));

  assert.equal(initialized.id, 1);
  assert.equal(started.id, 2);
  assert.equal(parseError.error.code, APP_SERVER_ERROR_CODES.PARSE_ERROR);
  assert.equal(lines.some((message) => message.id === 1), true);
  assert.equal(lines.some((message) => message.method === APP_SERVER_NOTIFICATIONS.THREAD_STARTED), true);
  assert.equal(lines.at(-1).error.code, APP_SERVER_ERROR_CODES.PARSE_ERROR);
  assert.equal(lines.every((message) => message.jsonrpc == null), true);
});

test("app-server fs methods read files, directories, and metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-js-app-fs-read-"));

  try {
    const filePath = join(dir, "hello.txt");
    await writeFile(filePath, "hello fs", "utf8");
    const server = new CodexAppServer({
      sandboxPolicy: new SandboxPolicy({
        mode: SANDBOX_MODES.READ_ONLY,
        workingDirectory: dir
      })
    });

    await server.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 1));

    const read = await server.handle(createRpcRequest(APP_SERVER_METHODS.FS_READ_FILE, {
      path: filePath
    }, 2));
    const metadata = await server.handle(createRpcRequest(APP_SERVER_METHODS.FS_GET_METADATA, {
      path: filePath
    }, 3));
    const directory = await server.handle(createRpcRequest(APP_SERVER_METHODS.FS_READ_DIRECTORY, {
      path: dir
    }, 4));

    assert.equal(Buffer.from(read.result.dataBase64, "base64").toString("utf8"), "hello fs");
    assert.equal(metadata.result.isFile, true);
    assert.equal(metadata.result.isDirectory, false);
    assert.equal(typeof metadata.result.modifiedAtMs, "number");
    assert.equal(directory.result.entries.some((entry) => entry.fileName === "hello.txt" && entry.isFile), true);
  } finally {
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
});

test("app-server fs writes are blocked by default and enabled explicitly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-js-app-fs-write-"));

  try {
    const blockedServer = new CodexAppServer();
    await blockedServer.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 1));

    const targetPath = join(dir, "blocked.txt");
    const blocked = await blockedServer.handle(createRpcRequest(APP_SERVER_METHODS.FS_WRITE_FILE, {
      path: targetPath,
      dataBase64: Buffer.from("blocked").toString("base64")
    }, 2));

    assert.equal(blocked.error.code, APP_SERVER_ERROR_CODES.INVALID_PARAMS);
    assert.equal(blocked.error.data.reason, "fs_write_blocked");

    const server = new CodexAppServer({
      allowFilesystemWrites: true,
      sandboxPolicy: new SandboxPolicy({
        mode: SANDBOX_MODES.WORKSPACE_WRITE,
        workingDirectory: dir
      })
    });

    await server.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 3));

    const nestedDir = join(dir, "nested");
    const created = await server.handle(createRpcRequest(APP_SERVER_METHODS.FS_CREATE_DIRECTORY, {
      path: nestedDir
    }, 4));
    const filePath = join(nestedDir, "hello.txt");
    const written = await server.handle(createRpcRequest(APP_SERVER_METHODS.FS_WRITE_FILE, {
      path: filePath,
      dataBase64: Buffer.from("hello write").toString("base64")
    }, 5));
    const copyPath = join(dir, "copy.txt");
    const copied = await server.handle(createRpcRequest(APP_SERVER_METHODS.FS_COPY, {
      sourcePath: filePath,
      destinationPath: copyPath
    }, 6));
    const removed = await server.handle(createRpcRequest(APP_SERVER_METHODS.FS_REMOVE, {
      path: filePath
    }, 7));

    assert.deepEqual(created.result, {});
    assert.deepEqual(written.result, {});
    assert.deepEqual(copied.result, {});
    assert.deepEqual(removed.result, {});
    assert.equal(await readFile(copyPath, "utf8"), "hello write");
  } finally {
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
});

test("app-server fs methods honor sandbox and approval gates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-js-app-fs-gates-"));

  try {
    const outsidePath = join(tmpdir(), `codex-js-outside-${Date.now()}.txt`);
    const sandboxServer = new CodexAppServer({
      allowFilesystemWrites: true,
      sandboxPolicy: new SandboxPolicy({
        mode: SANDBOX_MODES.WORKSPACE_WRITE,
        workingDirectory: dir
      })
    });
    await sandboxServer.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 1));

    const sandboxBlocked = await sandboxServer.handle(createRpcRequest(APP_SERVER_METHODS.FS_WRITE_FILE, {
      path: outsidePath,
      dataBase64: Buffer.from("outside").toString("base64")
    }, 2));

    assert.equal(sandboxBlocked.error.code, APP_SERVER_ERROR_CODES.INVALID_PARAMS);
    assert.equal(sandboxBlocked.error.data.reason, "sandbox_denied");

    const approvalServer = new CodexAppServer({
      allowFilesystemWrites: true,
      sandboxPolicy: new SandboxPolicy({
        mode: SANDBOX_MODES.WORKSPACE_WRITE,
        workingDirectory: dir
      }),
      approvalGate: new ApprovalGate({
        policy: new ApprovalPolicy({
          defaultDecision: APPROVAL_DECISIONS.PROMPT
        })
      })
    });
    await approvalServer.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 3));

    const approvalBlocked = await approvalServer.handle(createRpcRequest(APP_SERVER_METHODS.FS_WRITE_FILE, {
      path: join(dir, "needs-approval.txt"),
      dataBase64: Buffer.from("approval").toString("base64")
    }, 4));

    assert.equal(approvalBlocked.error.code, APP_SERVER_ERROR_CODES.INVALID_PARAMS);
    assert.equal(approvalBlocked.error.data.reason, "approval_required");
    assert.equal(approvalBlocked.error.data.approval.approvalRequest.resource_type, "tool");
    assert.equal(approvalBlocked.error.data.capability.resource, "tool");
    assert.equal(approvalBlocked.error.data.capability.action, "write");
    assert.equal(approvalBlocked.error.data.capability.metadata.source, "app-server-fs");
  } finally {
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
});

test("app-server fs/watch emits fs/changed notifications and fs/unwatch closes it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-js-app-fs-watch-"));
  const notifications = [];

  try {
    const watchedPath = join(dir, "watched.txt");
    await writeFile(watchedPath, "first", "utf8");
    const server = new CodexAppServer({
      sandboxPolicy: new SandboxPolicy({
        mode: SANDBOX_MODES.READ_ONLY,
        workingDirectory: dir
      }),
      /**
       * 处理 on notification 相关逻辑。
       *
       * @param {unknown} notification - notification 参数。
       * @returns {unknown} 返回处理后的结果。
       */
      onNotification(notification) {
        notifications.push(notification);
      }
    });

    await server.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 1));

    const watched = await server.handle(createRpcRequest(APP_SERVER_METHODS.FS_WATCH, {
      watchId: "watch-1",
      path: watchedPath
    }, 2));

    assert.equal(watched.result.path, watchedPath);

    await writeFile(watchedPath, "second", "utf8");
    await waitForNotification(notifications, APP_SERVER_NOTIFICATIONS.FS_CHANGED);

    const changed = notifications.find((notification) => notification.method === APP_SERVER_NOTIFICATIONS.FS_CHANGED);
    assert.equal(changed.params.watchId, "watch-1");
    assert.equal(changed.params.changedPaths.some((changedPath) => changedPath === watchedPath), true);

    const unwatched = await server.handle(createRpcRequest(APP_SERVER_METHODS.FS_UNWATCH, {
      watchId: "watch-1"
    }, 3));
    assert.deepEqual(unwatched.result, {});
  } finally {
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
});

test("app-server fs/watch rejects duplicate ids, missing watches, and sandbox escapes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-js-app-fs-watch-errors-"));

  try {
    const watchedPath = join(dir, "watched.txt");
    const outsidePath = join(tmpdir(), `codex-js-watch-outside-${Date.now()}.txt`);
    await writeFile(watchedPath, "first", "utf8");
    await writeFile(outsidePath, "outside", "utf8");
    const server = new CodexAppServer({
      sandboxPolicy: new SandboxPolicy({
        mode: SANDBOX_MODES.READ_ONLY,
        workingDirectory: dir
      })
    });

    await server.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 1));

    const watched = await server.handle(createRpcRequest(APP_SERVER_METHODS.FS_WATCH, {
      watchId: "watch-dup",
      path: watchedPath
    }, 2));
    const duplicate = await server.handle(createRpcRequest(APP_SERVER_METHODS.FS_WATCH, {
      watchId: "watch-dup",
      path: watchedPath
    }, 3));
    const missing = await server.handle(createRpcRequest(APP_SERVER_METHODS.FS_UNWATCH, {
      watchId: "missing"
    }, 4));
    const sandboxBlocked = await server.handle(createRpcRequest(APP_SERVER_METHODS.FS_WATCH, {
      watchId: "watch-outside",
      path: outsidePath
    }, 5));

    await server.handle(createRpcRequest(APP_SERVER_METHODS.FS_UNWATCH, {
      watchId: "watch-dup"
    }, 6));

    assert.equal(watched.result.path, watchedPath);
    assert.equal(duplicate.error.data.reason, "duplicate_watch_id");
    assert.equal(missing.error.data.reason, "watch_not_found");
    assert.equal(sandboxBlocked.error.data.reason, "sandbox_denied");
  } finally {
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
});

test("app-server process APIs require experimentalApi and are blocked by default", async () => {
  const server = new CodexAppServer();
  await server.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 1));

  const experimentalBlocked = await server.handle(createRpcRequest(APP_SERVER_METHODS.PROCESS_SPAWN, {
    command: [process.execPath, "-e", "console.log('hi')"],
    processHandle: "proc-1",
    cwd: tmpdir()
  }, 2));

  assert.equal(experimentalBlocked.error.code, APP_SERVER_ERROR_CODES.INVALID_PARAMS);
  assert.equal(experimentalBlocked.error.data.reason, "experimental_api_required");

  const blockedServer = new CodexAppServer();
  await blockedServer.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {
    capabilities: {
      experimentalApi: true
    }
  }, 3));

  const blocked = await blockedServer.handle(createRpcRequest(APP_SERVER_METHODS.PROCESS_SPAWN, {
    command: [process.execPath, "-e", "console.log('hi')"],
    processHandle: "proc-1",
    cwd: tmpdir()
  }, 4));

  assert.equal(blocked.error.code, APP_SERVER_ERROR_CODES.INVALID_PARAMS);
  assert.equal(blocked.error.data.reason, "blocked");
});

test("app-server process spawn records capability approval blocks", async () => {
  let spawned = false;
  const server = new CodexAppServer({
    processRuntime: {
      async spawn() {
        spawned = true;
        return {};
      }
    },
    approvalGate: new ApprovalGate({
      policy: new ApprovalPolicy({
        defaultDecision: APPROVAL_DECISIONS.PROMPT
      })
    })
  });

  await server.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {
    capabilities: {
      experimentalApi: true
    }
  }, 1));

  const blocked = await server.handle(createRpcRequest(APP_SERVER_METHODS.PROCESS_SPAWN, {
    command: [process.execPath, "-e", "console.log('hi')"],
    processHandle: "approval-process-1",
    cwd: tmpdir()
  }, 2));

  assert.equal(spawned, false);
  assert.equal(blocked.error.code, APP_SERVER_ERROR_CODES.INVALID_PARAMS);
  assert.equal(blocked.error.data.reason, "approval_required");
  assert.equal(blocked.error.data.approval.approvalRequest.resource_type, "exec");
  assert.equal(blocked.error.data.capability.resource, "exec");
  assert.equal(blocked.error.data.capability.action, "execute");
  assert.equal(blocked.error.data.capability.metadata.source, "app-server-process");
  assert.equal(blocked.error.data.serverRequest.method, "item/commandExecution/requestApproval");
});

test("app-server process APIs spawn real processes with output and exit notifications when injected", async () => {
  const notifications = [];
  const runtime = new RealProcessRuntime({
    defaultTimeoutMs: 5000
  });
  const server = new CodexAppServer({
    processRuntime: runtime,
    /**
     * 处理 on notification 相关逻辑。
     *
     * @param {unknown} notification - notification 参数。
     * @returns {unknown} 返回处理后的结果。
     */
    onNotification(notification) {
      notifications.push(notification);
    }
  });

  await server.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {
    capabilities: {
      experimentalApi: true
    }
  }, 1));

  const spawned = await server.handle(createRpcRequest(APP_SERVER_METHODS.PROCESS_SPAWN, {
    command: [
      process.execPath,
      "-e",
      "process.stdin.on('data', d => process.stdout.write('got:' + d)); process.stdin.on('end', () => process.stderr.write('done'))"
    ],
    processHandle: "real-process-1",
    cwd: tmpdir(),
    streamStdin: true,
    streamStdoutStderr: true,
    outputBytesCap: null,
    timeoutMs: 5000
  }, 2));

  assert.deepEqual(spawned.result, {});

  const wrote = await server.handle(createRpcRequest(APP_SERVER_METHODS.PROCESS_WRITE_STDIN, {
    processHandle: "real-process-1",
    deltaBase64: Buffer.from("hello\n").toString("base64"),
    closeStdin: true
  }, 3));

  assert.deepEqual(wrote.result, {});

  const exited = await waitForNotification(notifications, APP_SERVER_NOTIFICATIONS.PROCESS_EXITED);
  const outputDeltas = notifications.filter((notification) =>
    notification.method === APP_SERVER_NOTIFICATIONS.PROCESS_OUTPUT_DELTA
  );

  assert.equal(exited.params.processHandle, "real-process-1");
  assert.equal(exited.params.exitCode, 0);
  assert.equal(exited.params.stdout, "");
  assert.equal(exited.params.stderr, "");
  assert.equal(outputDeltas.some((notification) =>
    Buffer.from(notification.params.deltaBase64, "base64").toString("utf8").includes("got:hello")
  ), true);
  assert.equal(outputDeltas.some((notification) => notification.params.stream === "stderr"), true);
});

test("app-server process APIs reject duplicate handles and support resize and kill", async () => {
  const notifications = [];
  const runtime = new RealProcessRuntime({
    defaultTimeoutMs: 5000
  });
  const server = new CodexAppServer({
    processRuntime: runtime,
    /**
     * 处理 on notification 相关逻辑。
     *
     * @param {unknown} notification - notification 参数。
     * @returns {unknown} 返回处理后的结果。
     */
    onNotification(notification) {
      notifications.push(notification);
    }
  });

  await server.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {
    capabilities: {
      experimentalApi: true
    }
  }, 1));

  const spawned = await server.handle(createRpcRequest(APP_SERVER_METHODS.PROCESS_SPAWN, {
    command: [
      process.execPath,
      "-e",
      "setTimeout(() => {}, 2000)"
    ],
    processHandle: "real-process-dup",
    cwd: tmpdir(),
    tty: true,
    size: {
      rows: 24,
      cols: 80
    },
    timeoutMs: null,
    outputBytesCap: null
  }, 2));
  const duplicate = await server.handle(createRpcRequest(APP_SERVER_METHODS.PROCESS_SPAWN, {
    command: [
      process.execPath,
      "-e",
      "console.log('second')"
    ],
    processHandle: "real-process-dup",
    cwd: tmpdir(),
    timeoutMs: 1000
  }, 3));
  const resized = await server.handle(createRpcRequest(APP_SERVER_METHODS.PROCESS_RESIZE_PTY, {
    processHandle: "real-process-dup",
    size: {
      rows: 40,
      cols: 120
    }
  }, 4));
  const killed = await server.handle(createRpcRequest(APP_SERVER_METHODS.PROCESS_KILL, {
    processHandle: "real-process-dup"
  }, 5));

  await waitForNotification(notifications, APP_SERVER_NOTIFICATIONS.PROCESS_EXITED);

  assert.deepEqual(spawned.result, {});
  assert.equal(duplicate.error.data.reason, "duplicate_process_handle");
  assert.deepEqual(resized.result, {});
  assert.deepEqual(killed.result, {});
  assert.deepEqual(runtime.get("real-process-dup").terminalSize, {
    rows: 40,
    cols: 120
  });
});

test("app-server resumes stored threads", async () => {
  const sessionStoreDirectory = await mkdtemp(join(tmpdir(), "codex-js-app-resume-"));

  try {
    const codex = new Codex({
      sessionStoreDirectory,
      mockResponse: "done"
    });
    const first = codex.startThread();
    await first.run("first");

    const server = new CodexAppServer({
      codex
    });
    await server.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 1));

    const resumed = await server.handle(createRpcRequest(APP_SERVER_METHODS.THREAD_RESUME, {
      threadId: first.id
    }, 2));

    assert.equal(resumed.result.thread.id, first.id);
    assert.equal(resumed.result.thread.turns.length, 1);

    const listed = await server.handle(createRpcRequest(APP_SERVER_METHODS.THREAD_LIST, {}, 3));
    assert.deepEqual(listed.result.threads.map((thread) => thread.id), [first.id]);
  } finally {
    await rm(sessionStoreDirectory, {
      recursive: true,
      force: true
    });
  }
});

test("app-server manages stored threads from disk", async () => {
  const sessionStoreDirectory = await mkdtemp(join(tmpdir(), "codex-js-app-thread-store-"));
  const notifications = [];

  try {
    const codex = new Codex({
      sessionStoreDirectory,
      mockResponse: "done"
    });
    const source = codex.startThread({
      workingDirectory: sessionStoreDirectory
    });
    await source.run("first");
    await source.run("second");

    const server = new CodexAppServer({
      codex,
      /**
       * 处理 on notification 相关逻辑。
       *
       * @param {unknown} notification - notification 参数。
       * @returns {unknown} 返回处理后的结果。
       */
      onNotification(notification) {
        notifications.push(notification);
      }
    });
    await server.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 1));

    const listed = await server.handle(createRpcRequest(APP_SERVER_METHODS.THREAD_LIST, {
      searchTerm: "first"
    }, 2));
    assert.equal(listed.result.threads.length, 1);
    assert.equal(listed.result.threads[0].status.type, "notLoaded");

    const forked = await server.handle(createRpcRequest(APP_SERVER_METHODS.THREAD_FORK, {
      threadId: source.id
    }, 3));
    assert.equal(forked.result.thread.forkedFromId, source.id);
    assert.equal(forked.result.thread.turns.length, 2);

    const rolledBack = await server.handle(createRpcRequest(APP_SERVER_METHODS.THREAD_ROLLBACK, {
      threadId: source.id,
      dropLastTurns: 1
    }, 4));
    assert.equal(rolledBack.result.thread.turns.length, 1);

    const metadata = await server.handle(createRpcRequest(APP_SERVER_METHODS.THREAD_METADATA_UPDATE, {
      threadId: source.id,
      metadata: {
        title: "hello"
      }
    }, 5));
    assert.equal(metadata.result.thread.metadata.title, "hello");

    const archived = await server.handle(createRpcRequest(APP_SERVER_METHODS.THREAD_ARCHIVE, {
      threadId: source.id
    }, 6));
    assert.deepEqual(archived.result, {});
    assert.equal(notifications.some((notification) => notification.method === APP_SERVER_NOTIFICATIONS.THREAD_ARCHIVED), true);

    const archivedList = await server.handle(createRpcRequest(APP_SERVER_METHODS.THREAD_LIST, {
      archived: true
    }, 7));
    assert.equal(archivedList.result.threads.some((thread) => thread.id === source.id), true);

    const unarchived = await server.handle(createRpcRequest(APP_SERVER_METHODS.THREAD_UNARCHIVE, {
      threadId: source.id
    }, 8));
    assert.equal(unarchived.result.thread.archived, false);
    assert.equal(notifications.some((notification) => notification.method === APP_SERVER_NOTIFICATIONS.THREAD_UNARCHIVED), true);
  } finally {
    await rm(sessionStoreDirectory, {
      recursive: true,
      force: true
    });
  }
});

test("app-server lists loaded threads and sets thread names", async () => {
  const sessionStoreDirectory = await mkdtemp(join(tmpdir(), "codex-js-app-thread-name-"));
  const notifications = [];

  try {
    const server = new CodexAppServer({
      codex: new Codex({
        sessionStoreDirectory,
        mockResponse: "done"
      }),
      /**
       * 处理 on notification 相关逻辑。
       *
       * @param {unknown} notification - notification 参数。
       * @returns {unknown} 返回处理后的结果。
       */
      onNotification(notification) {
        notifications.push(notification);
      }
    });

    await server.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 1));

    const started = await server.handle(createRpcRequest(APP_SERVER_METHODS.THREAD_START, {
      cwd: sessionStoreDirectory
    }, 2));
    const threadId = started.result.thread.id;

    assert.equal(started.result.thread.status.type, THREAD_STATUS_TYPES.IDLE);

    const loaded = await server.handle(createRpcRequest(APP_SERVER_METHODS.THREAD_LOADED_LIST, {}, 3));

    assert.deepEqual(loaded.result.threadIds, [threadId]);
    assert.equal(loaded.result.threads[0].status.type, THREAD_STATUS_TYPES.IDLE);

    const named = await server.handle(createRpcRequest(APP_SERVER_METHODS.THREAD_NAME_SET, {
      threadId,
      name: "Migration work"
    }, 4));

    assert.deepEqual(named.result, {});
    assert.equal(notifications.some((entry) => entry.method === APP_SERVER_NOTIFICATIONS.THREAD_NAME_UPDATED), true);

    const read = await server.handle(createRpcRequest(APP_SERVER_METHODS.THREAD_READ, {
      threadId
    }, 5));

    assert.equal(read.result.thread.name, "Migration work");
    assert.equal(read.result.thread.metadata.name, "Migration work");
  } finally {
    await rm(sessionStoreDirectory, {
      recursive: true,
      force: true
    });
  }
});

test("app-server turn steer and interrupt operate on active turn control records", async () => {
  const notifications = [];
  const server = new CodexAppServer({
    /**
     * 处理 on notification 相关逻辑。
     *
     * @param {unknown} notification - notification 参数。
     * @returns {unknown} 返回处理后的结果。
     */
    onNotification(notification) {
      notifications.push(notification);
    }
  });

  await server.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 1));

  const started = await server.handle(createRpcRequest(APP_SERVER_METHODS.THREAD_START, {}, 2));
  const threadId = started.result.thread.id;
  const turnId = "turn-control-1";

  server.setActiveTurn(threadId, createTurnControlRecord({
    threadId,
    turnId,
    status: TURN_CONTROL_STATUSES.ACTIVE,
    input: "initial"
  }));

  const steered = await server.handle(createRpcRequest(APP_SERVER_METHODS.TURN_STEER, {
    threadId,
    input: "add this",
    clientUserMessageId: "client-msg-1"
  }, 3));

  assert.equal(steered.result.turnId, turnId);
  assert.equal(server.activeTurns.get(threadId).steerMessages[0].clientId, "client-msg-1");
  assert.equal(
    notifications.some((entry) =>
      entry.method === APP_SERVER_NOTIFICATIONS.ITEM_COMPLETED &&
      entry.params.item.type === "userMessage"
    ),
    true
  );

  const interrupted = await server.handle(createRpcRequest(APP_SERVER_METHODS.TURN_INTERRUPT, {
    threadId,
    turnId
  }, 4));

  assert.deepEqual(interrupted.result, {});
  assert.equal(server.activeTurns.has(threadId), false);
  assert.equal(
    notifications.some((entry) =>
      entry.method === APP_SERVER_NOTIFICATIONS.TURN_COMPLETED &&
      entry.params.status === "interrupted"
    ),
    true
  );

  const notActive = await server.handle(createRpcRequest(APP_SERVER_METHODS.TURN_STEER, {
    threadId,
    input: "too late"
  }, 5));

  assert.equal(notActive.error.code, APP_SERVER_ERROR_CODES.INVALID_PARAMS);
  assert.equal(notActive.error.data.reason, "turn_not_active");
});

test("app-server thread/unsubscribe reports loaded subscription status", async () => {
  await mkdir(TEST_TMP_ROOT, {
    recursive: true
  });
  const sessionStoreDirectory = await mkdtemp(join(TEST_TMP_ROOT, "app-unsubscribe-"));

  try {
    const server = new CodexAppServer({
      codex: new Codex({
        sessionStoreDirectory
      }),
      sessionStoreDirectory
    });

    await server.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 1));

    const missing = await server.handle(createRpcRequest(APP_SERVER_METHODS.THREAD_UNSUBSCRIBE, {
      threadId: "missing"
    }, 2));
    assert.equal(missing.result.status, "notLoaded");

    const started = await server.handle(createRpcRequest(APP_SERVER_METHODS.THREAD_START, {
      cwd: sessionStoreDirectory
    }, 3));
    const threadId = started.result.thread.id;

    const first = await server.handle(createRpcRequest(APP_SERVER_METHODS.THREAD_UNSUBSCRIBE, {
      threadId
    }, 4));
    const second = await server.handle(createRpcRequest(APP_SERVER_METHODS.THREAD_UNSUBSCRIBE, {
      threadId
    }, 5));
    const loaded = await server.handle(createRpcRequest(APP_SERVER_METHODS.THREAD_LOADED_LIST, {}, 6));

    assert.equal(first.result.status, "unsubscribed");
    assert.equal(second.result.status, "notSubscribed");
    assert.equal(loaded.result.threadIds.includes(threadId), true);
  } finally {
    await rm(sessionStoreDirectory, {
      recursive: true,
      force: true
    });
  }
});

test("app-server thread/inject_items persists raw response items for the next turn", async () => {
  await mkdir(TEST_TMP_ROOT, {
    recursive: true
  });
  const sessionStoreDirectory = await mkdtemp(join(TEST_TMP_ROOT, "app-inject-"));
  const contexts = [];

  try {
    const server = new CodexAppServer({
      codex: new Codex({
        sessionStoreDirectory,
        runtime: {
          /**
           * 执行一轮 agent turn 并按事件流产出进度。
           *
           * 这是异步生成器，会按需产出事件或结果。
           *
           * @param {unknown} context - context 参数。
           * @returns {unknown} 返回处理后的结果。
           */
          async *runTurn(context) {
            contexts.push(context.toJSON());
            yield createItemCompletedEvent(createAssistantMessageItem(`turn ${contexts.length}`, {
              status: "completed"
            }));
            yield createTurnCompletedEvent();
          }
        }
      }),
      sessionStoreDirectory
    });

    await server.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 1));

    const started = await server.handle(createRpcRequest(APP_SERVER_METHODS.THREAD_START, {
      cwd: sessionStoreDirectory
    }, 2));
    const threadId = started.result.thread.id;

    const injected = await server.handle(createRpcRequest(APP_SERVER_METHODS.THREAD_INJECT_ITEMS, {
      threadId,
      items: [
        {
          id: "msg-injected",
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "Previously computed context."
            }
          ]
        }
      ]
    }, 3));

    assert.deepEqual(injected.result, {});

    const read = await server.handle(createRpcRequest(APP_SERVER_METHODS.THREAD_READ, {
      threadId,
      includeTurns: true
    }, 4));
    assert.equal(read.result.thread.turns.length, 0);
    assert.equal(read.result.thread.metadata.lastInjectedAt != null, true);

    await server.handle(createRpcRequest(APP_SERVER_METHODS.TURN_START, {
      threadId,
      input: "continue"
    }, 5));

    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].response_input_items.length, 1);
    assert.equal(contexts[0].response_input_items[0].id, "msg-injected");
    assert.equal(contexts[0].response_input_items[0].content[0].text, "Previously computed context.");
  } finally {
    await rm(sessionStoreDirectory, {
      recursive: true,
      force: true
    });
  }
});

test("app-server stores thread goals and emits goal notifications", async () => {
  const sessionStoreDirectory = await mkdtemp(join(tmpdir(), "codex-js-app-thread-goal-"));
  const notifications = [];

  try {
    const server = new CodexAppServer({
      codex: new Codex({
        sessionStoreDirectory,
        mockResponse: "done"
      }),
      /**
       * 处理 on notification 相关逻辑。
       *
       * @param {unknown} notification - notification 参数。
       * @returns {unknown} 返回处理后的结果。
       */
      onNotification(notification) {
        notifications.push(notification);
      }
    });

    await server.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 1));

    const started = await server.handle(createRpcRequest(APP_SERVER_METHODS.THREAD_START, {
      cwd: sessionStoreDirectory
    }, 2));
    const threadId = started.result.thread.id;

    const set = await server.handle(createRpcRequest(APP_SERVER_METHODS.THREAD_GOAL_SET, {
      threadId,
      objective: "Migrate non-model Codex features",
      status: THREAD_GOAL_STATUSES.ACTIVE,
      tokenBudget: 1234
    }, 3));

    assert.equal(set.result.goal.threadId, threadId);
    assert.equal(set.result.goal.objective, "Migrate non-model Codex features");
    assert.equal(set.result.goal.status, THREAD_GOAL_STATUSES.ACTIVE);
    assert.equal(set.result.goal.tokenBudget, 1234);
    assert.equal(typeof set.result.goal.createdAt, "number");
    assert.equal(notifications.some((entry) => entry.method === APP_SERVER_NOTIFICATIONS.THREAD_GOAL_UPDATED), true);

    const get = await server.handle(createRpcRequest(APP_SERVER_METHODS.THREAD_GOAL_GET, {
      threadId
    }, 4));

    assert.equal(get.result.goal.objective, "Migrate non-model Codex features");

    const updated = await server.handle(createRpcRequest(APP_SERVER_METHODS.THREAD_GOAL_SET, {
      threadId,
      status: THREAD_GOAL_STATUSES.BLOCKED
    }, 5));

    assert.equal(updated.result.goal.objective, "Migrate non-model Codex features");
    assert.equal(updated.result.goal.status, THREAD_GOAL_STATUSES.BLOCKED);

    const cleared = await server.handle(createRpcRequest(APP_SERVER_METHODS.THREAD_GOAL_CLEAR, {
      threadId
    }, 6));
    const clearedAgain = await server.handle(createRpcRequest(APP_SERVER_METHODS.THREAD_GOAL_CLEAR, {
      threadId
    }, 7));
    const empty = await server.handle(createRpcRequest(APP_SERVER_METHODS.THREAD_GOAL_GET, {
      threadId
    }, 8));

    assert.equal(cleared.result.cleared, true);
    assert.equal(clearedAgain.result.cleared, false);
    assert.equal(empty.result.goal, null);
    assert.equal(notifications.some((entry) => entry.method === APP_SERVER_NOTIFICATIONS.THREAD_GOAL_CLEARED), true);
  } finally {
    await rm(sessionStoreDirectory, {
      recursive: true,
      force: true
    });
  }
});

test("app-server lists built-in permission profiles with pagination", async () => {
  const server = createCodexAppServer();

  await server.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 1));

  const first = await server.handle(createRpcRequest(APP_SERVER_METHODS.PERMISSION_PROFILE_LIST, {
    limit: 2
  }, 2));

  assert.equal(first.result.data.length, 2);
  assert.equal(first.result.data[0].id, "read-only");
  assert.equal(first.result.data[0].sandboxMode, SANDBOX_MODES.READ_ONLY);
  assert.equal(typeof first.result.nextCursor, "string");

  const second = await server.handle(createRpcRequest(APP_SERVER_METHODS.PERMISSION_PROFILE_LIST, {
    cursor: first.result.nextCursor
  }, 3));

  assert.equal(second.result.data.some((profile) => profile.id === "danger-full-access"), true);
  assert.equal(second.result.nextCursor, null);
});

test("app-server config/read returns effective safe config and optional layers", async () => {
  await mkdir(TEST_TMP_ROOT, {
    recursive: true
  });
  const dir = await mkdtemp(join(TEST_TMP_ROOT, "app-config-"));

  try {
    const configPath = join(dir, "codex-js.config.json");
    await writeFile(configPath, JSON.stringify({
      workingDirectory: dir,
      mockResponse: "from app-server config",
      sandbox: {
        mode: SANDBOX_MODES.READ_ONLY
      },
      approval: {
        defaultDecision: "never"
      }
    }), "utf8");

    const server = new CodexAppServer({
      configPath
    });

    await server.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 1));

    const read = await server.handle(createRpcRequest(APP_SERVER_METHODS.CONFIG_READ, {
      includeLayers: true
    }, 2));

    assert.equal(read.result.config.model_provider, "mock");
    assert.equal(read.result.config.approval_policy, "never");
    assert.equal(read.result.config.sandbox_mode, SANDBOX_MODES.READ_ONLY);
    assert.equal(read.result.config.codex_js.mockResponse, "from app-server config");
    assert.equal(Array.isArray(read.result.layers), true);
    assert.equal(read.result.layers.some((layer) => layer.name === "file"), true);
    assert.equal(read.result.origins.mockResponse.name, "file");
  } finally {
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
});

test("app-server config/value/write is blocked by default", async () => {
  await mkdir(TEST_TMP_ROOT, {
    recursive: true
  });
  const dir = await mkdtemp(join(TEST_TMP_ROOT, "app-config-write-blocked-"));

  try {
    const configPath = join(dir, "codex-js.config.json");
    const server = new CodexAppServer({
      configPath
    });

    await server.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 1));

    const write = await server.handle(createRpcRequest(APP_SERVER_METHODS.CONFIG_VALUE_WRITE, {
      keyPath: "mockResponse",
      value: "blocked",
      mergeStrategy: "replace"
    }, 2));

    assert.equal(write.error.code, APP_SERVER_ERROR_CODES.INVALID_PARAMS);
    assert.equal(write.error.data.reason, "config_write_disabled");
    assert.equal(write.error.data.config_write_error_code, "configLayerReadonly");
  } finally {
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
});

test("app-server config/value/write writes JSON config when explicitly enabled", async () => {
  await mkdir(TEST_TMP_ROOT, {
    recursive: true
  });
  const dir = await mkdtemp(join(TEST_TMP_ROOT, "app-config-write-"));

  try {
    const configPath = join(dir, "codex-js.config.json");
    await writeFile(configPath, JSON.stringify({
      mockResponse: "before"
    }), "utf8");
    const expectedVersion = createConfigVersion({
      mockResponse: "before"
    });
    const server = new CodexAppServer({
      configPath,
      allowConfigWrites: true
    });

    await server.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 1));

    const write = await server.handle(createRpcRequest(APP_SERVER_METHODS.CONFIG_VALUE_WRITE, {
      keyPath: "mockResponse",
      value: "after",
      mergeStrategy: "replace",
      expectedVersion
    }, 2));

    assert.equal(write.result.status, "ok");
    assert.equal(write.result.filePath, configPath);
    assert.equal(write.result.overriddenMetadata, null);

    const stored = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(stored.mockResponse, "after");

    const read = await server.handle(createRpcRequest(APP_SERVER_METHODS.CONFIG_READ, {}, 3));
    assert.equal(read.result.config.codex_js.mockResponse, "after");
  } finally {
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
});

test("app-server config/batchWrite applies replace, upsert, and clear atomically", async () => {
  await mkdir(TEST_TMP_ROOT, {
    recursive: true
  });
  const dir = await mkdtemp(join(TEST_TMP_ROOT, "app-config-batch-"));

  try {
    const configPath = join(dir, "codex-js.config.json");
    await writeFile(configPath, JSON.stringify({
      runtime: {
        mcpEnabled: false
      },
      sandbox: {
        mode: SANDBOX_MODES.READ_ONLY
      },
      desktop: {
        appearanceTheme: "light",
        workspace: {
          width: 240
        }
      }
    }), "utf8");
    const server = new CodexAppServer({
      configPath,
      allowConfigWrites: true
    });

    await server.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 1));

    const batch = await server.handle(createRpcRequest(APP_SERVER_METHODS.CONFIG_BATCH_WRITE, {
      filePath: configPath,
      reloadUserConfig: true,
      edits: [
        {
          keyPath: "runtime",
          value: {
            realShellEnabled: true
          },
          mergeStrategy: "upsert"
        },
        {
          keyPath: "sandbox.mode",
          value: "workspace-write",
          mergeStrategy: "replace"
        },
        {
          keyPath: "desktop.appearanceTheme",
          value: null,
          mergeStrategy: "replace"
        },
        {
          keyPath: "desktop.\"selected-avatar-id\"",
          value: "codex",
          mergeStrategy: "replace"
        }
      ]
    }, 2));

    assert.equal(batch.result.status, "ok");
    assert.equal(batch.result.reloadUserConfig, true);

    const read = await server.handle(createRpcRequest(APP_SERVER_METHODS.CONFIG_READ, {}, 3));
    assert.equal(read.result.config.codex_js.runtime.mcpEnabled, false);
    assert.equal(read.result.config.codex_js.runtime.realShellEnabled, true);
    assert.equal(read.result.config.codex_js.sandbox.mode, "workspace-write");
    assert.equal(read.result.config.desktop.appearanceTheme, undefined);
    assert.equal(read.result.config.desktop["selected-avatar-id"], "codex");
  } finally {
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
});

test("app-server config writes reject version conflict and invalid key paths without writing", async () => {
  await mkdir(TEST_TMP_ROOT, {
    recursive: true
  });
  const dir = await mkdtemp(join(TEST_TMP_ROOT, "app-config-conflict-"));

  try {
    const configPath = join(dir, "codex-js.config.json");
    await writeFile(configPath, JSON.stringify({
      mockResponse: "original"
    }), "utf8");
    const server = new CodexAppServer({
      configPath,
      allowConfigWrites: true
    });

    await server.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 1));

    const conflict = await server.handle(createRpcRequest(APP_SERVER_METHODS.CONFIG_VALUE_WRITE, {
      keyPath: "mockResponse",
      value: "conflict",
      mergeStrategy: "replace",
      expectedVersion: "sha256:stale"
    }, 2));

    assert.equal(conflict.error.code, APP_SERVER_ERROR_CODES.INVALID_PARAMS);
    assert.equal(conflict.error.data.config_write_error_code, "configVersionConflict");

    const invalid = await server.handle(createRpcRequest(APP_SERVER_METHODS.CONFIG_VALUE_WRITE, {
      keyPath: "runtime..mcpEnabled",
      value: true,
      mergeStrategy: "replace"
    }, 3));

    assert.equal(invalid.error.code, APP_SERVER_ERROR_CODES.INVALID_PARAMS);
    assert.equal(invalid.error.data.config_write_error_code, "configValidationError");

    const stored = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(stored.mockResponse, "original");
  } finally {
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
});

test("app-server configRequirements/read returns null or injected constraints", async () => {
  const emptyServer = createCodexAppServer();
  await emptyServer.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 1));

  const empty = await emptyServer.handle(createRpcRequest(APP_SERVER_METHODS.CONFIG_REQUIREMENTS_READ, {}, 2));
  assert.equal(empty.result.requirements, null);

  const server = new CodexAppServer({
    configRequirements: {
      allowedApprovalPolicies: ["on-request", "never"],
      allowedSandboxModes: [SANDBOX_MODES.READ_ONLY],
      allowManagedHooksOnly: true,
      featureRequirements: {
        mcp: false
      }
    }
  });

  await server.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 3));

  const read = await server.handle(createRpcRequest(APP_SERVER_METHODS.CONFIG_REQUIREMENTS_READ, {}, 4));

  assert.deepEqual(read.result.requirements.allowedApprovalPolicies, ["on-request", "never"]);
  assert.deepEqual(read.result.requirements.allowedSandboxModes, [SANDBOX_MODES.READ_ONLY]);
  assert.equal(read.result.requirements.allowManagedHooksOnly, true);
  assert.deepEqual(read.result.requirements.featureRequirements, {
    mcp: false
  });
});

test("app-server experimentalFeature/list pages feature metadata", async () => {
  const server = createCodexAppServer();
  await server.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 1));

  const first = await server.handle(createRpcRequest(APP_SERVER_METHODS.EXPERIMENTAL_FEATURE_LIST, {
    limit: 2
  }, 2));

  assert.equal(first.result.data.length, 2);
  assert.equal(typeof first.result.data[0].name, "string");
  assert.equal(typeof first.result.data[0].stage, "string");
  assert.equal(typeof first.result.data[0].enabled, "boolean");
  assert.equal(typeof first.result.data[0].defaultEnabled, "boolean");
  assert.equal(typeof first.result.nextCursor, "string");

  const second = await server.handle(createRpcRequest(APP_SERVER_METHODS.EXPERIMENTAL_FEATURE_LIST, {
    cursor: first.result.nextCursor,
    limit: 1000
  }, 3));

  assert.equal(second.result.data.length > 0, true);
  assert.equal(second.result.nextCursor, null);
});

test("app-server experimentalFeature/enablement/set updates runtime feature projection", async () => {
  const server = createCodexAppServer();
  await server.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 1));

  const set = await server.handle(createRpcRequest(APP_SERVER_METHODS.EXPERIMENTAL_FEATURE_ENABLEMENT_SET, {
    enablement: {
      auth_elicitation: true,
      unknown_feature: true
    }
  }, 2));

  assert.deepEqual(set.result.enablement, {
    auth_elicitation: true
  });

  const listed = await server.handle(createRpcRequest(APP_SERVER_METHODS.EXPERIMENTAL_FEATURE_LIST, {}, 3));
  const authElicitation = listed.result.data.find((feature) => feature.name === "auth_elicitation");

  assert.equal(authElicitation.enabled, true);

  const read = await server.handle(createRpcRequest(APP_SERVER_METHODS.CONFIG_READ, {}, 4));
  assert.equal(read.result.config.features.auth_elicitation, true);
});

test("app-server experimentalFeature/list rejects unknown loaded thread ids", async () => {
  const server = createCodexAppServer();
  await server.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 1));

  const response = await server.handle(createRpcRequest(APP_SERVER_METHODS.EXPERIMENTAL_FEATURE_LIST, {
    threadId: "00000000-0000-4000-8000-000000000001"
  }, 2));

  assert.equal(response.error.code, APP_SERVER_ERROR_CODES.INVALID_REQUEST);
  assert.equal(response.error.data.reason, "thread_not_found");
});

test("app-server maps MCP status, resource read, and tool call methods", async () => {
  const server = new CodexAppServer({
    mcpRuntime: new McpRuntime({
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
      })
    })
  });

  await server.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 1));

  const statuses = await server.handle(createRpcRequest(APP_SERVER_METHODS.MCP_SERVER_STATUS_LIST, {}, 2));
  assert.equal(statuses.result.servers[0].name, "fs");

  const resource = await server.handle(createRpcRequest(APP_SERVER_METHODS.MCP_RESOURCE_READ, {
    server: "fs",
    uri: "file:///README.md"
  }, 3));
  assert.equal(resource.result.contents[0].text, "hello");

  const tool = await server.handle(createRpcRequest(APP_SERVER_METHODS.MCP_TOOL_CALL, {
    server: "fs",
    tool: "read",
    arguments: {}
  }, 4));
  assert.equal(tool.result.result.output, "read ok");
});

test("thread events map to app-server notifications", () => {
  const notification = threadEventToAppServerNotification({
    type: "item.completed",
    item: {
      id: "item-1"
    }
  }, "thread-1", "turn-1");

  assert.equal(notification.method, APP_SERVER_NOTIFICATIONS.ITEM_COMPLETED);
  assert.equal(notification.params.threadId, "thread-1");
  assert.equal(notification.params.turnId, "turn-1");
  assert.equal(notification.params.item.id, "item-1");
});

test("app-server command approval creates server requests and resolves them", async () => {
  const serverRequests = [];
  const notifications = [];
  const server = new CodexAppServer({
    approvalGate: new ApprovalGate({
      policy: new ApprovalPolicy({
        defaultDecision: APPROVAL_DECISIONS.PROMPT
      })
    }),
    /**
     * 处理 on server request 相关逻辑。
     *
     * @param {unknown} request - request 参数。
     * @returns {unknown} 返回处理后的结果。
     */
    onServerRequest(request) {
      serverRequests.push(request);
    },
    /**
     * 处理 on notification 相关逻辑。
     *
     * @param {unknown} notification - notification 参数。
     * @returns {unknown} 返回处理后的结果。
     */
    onNotification(notification) {
      notifications.push(notification);
    }
  });

  await server.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 1));

  const blocked = await server.handle(createRpcRequest(APP_SERVER_METHODS.COMMAND_EXEC, {
    command: "npm test",
    process_id: "approval-proc",
    stream_stdin: true
  }, 2));

  assert.equal(blocked.error.data.reason, "approval_required");
  assert.equal(blocked.error.data.serverRequest.method, "item/commandExecution/requestApproval");
  assert.equal(serverRequests.length, 1);
  assert.equal(serverRequests[0].method, "item/commandExecution/requestApproval");
  assert.equal(serverRequests[0].params.command, "npm test");

  const listed = await server.handle(createRpcRequest(APP_SERVER_METHODS.SERVER_REQUEST_LIST, {}, 3));
  assert.equal(listed.result.requests.length, 1);

  const resolved = await server.handle(createRpcRequest(APP_SERVER_METHODS.SERVER_REQUEST_RESOLVE, {
    requestId: blocked.error.data.requestId,
    response: {
      decision: "acceptForSession"
    }
  }, 4));

  assert.equal(resolved.result.request.requestId, blocked.error.data.requestId);
  assert.equal(notifications.some((entry) => entry.method === APP_SERVER_NOTIFICATIONS.SERVER_REQUEST_RESOLVED), true);

  const allowed = await server.handle(createRpcRequest(APP_SERVER_METHODS.COMMAND_EXEC, {
    command: "npm test",
    process_id: "approval-proc",
    stream_stdin: true
  }, 5));

  assert.equal(allowed.result.command.status, "completed");
  assert.equal(allowed.result.command.sessionId, 1);
});

test("app-server fs approval creates file-change requests and accepts JSON-RPC responses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-js-app-fs-approval-"));
  const serverRequests = [];
  const notifications = [];

  try {
    const server = new CodexAppServer({
      allowFilesystemWrites: true,
      sandboxPolicy: new SandboxPolicy({
        mode: SANDBOX_MODES.WORKSPACE_WRITE,
        workingDirectory: dir
      }),
      approvalGate: new ApprovalGate({
        policy: new ApprovalPolicy({
          defaultDecision: APPROVAL_DECISIONS.PROMPT
        })
      }),
      /**
       * 处理 on server request 相关逻辑。
       *
       * @param {unknown} request - request 参数。
       * @returns {unknown} 返回处理后的结果。
       */
      onServerRequest(request) {
        serverRequests.push(request);
      },
      /**
       * 处理 on notification 相关逻辑。
       *
       * @param {unknown} notification - notification 参数。
       * @returns {unknown} 返回处理后的结果。
       */
      onNotification(notification) {
        notifications.push(notification);
      }
    });

    await server.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 1));

    const targetPath = join(dir, "approved.txt");
    const blocked = await server.handle(createRpcRequest(APP_SERVER_METHODS.FS_WRITE_FILE, {
      path: targetPath,
      dataBase64: Buffer.from("approved").toString("base64")
    }, 2));

    assert.equal(blocked.error.data.reason, "approval_required");
    assert.equal(blocked.error.data.serverRequest.method, "item/fileChange/requestApproval");
    assert.equal(serverRequests.length, 1);
    assert.equal(serverRequests[0].method, "item/fileChange/requestApproval");

    const response = await server.handle({
      id: blocked.error.data.requestId,
      result: {
        decision: "acceptForSession"
      }
    });

    assert.equal(response, null);
    assert.equal(notifications.some((entry) => entry.method === APP_SERVER_NOTIFICATIONS.SERVER_REQUEST_RESOLVED), true);

    const written = await server.handle(createRpcRequest(APP_SERVER_METHODS.FS_WRITE_FILE, {
      path: targetPath,
      dataBase64: Buffer.from("approved").toString("base64")
    }, 3));

    assert.deepEqual(written.result, {});
    assert.equal(await readFile(targetPath, "utf8"), "approved");
  } finally {
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
});

test("app-server resolves permissions approval requests and records granted subset", async () => {
  const permissionGrantStore = new PermissionGrantStore();
  const serverRequests = [];
  const notifications = [];
  const server = new CodexAppServer({
    permissionGrantStore,
    serverRequestStore: new ServerRequestStore({
      /**
       * 处理 on request 相关逻辑。
       *
       * @param {unknown} request - request 参数。
       * @returns {unknown} 返回处理后的结果。
       */
      onRequest(request) {
        serverRequests.push(request);
      }
    }),
    /**
     * 处理 on notification 相关逻辑。
     *
     * @param {unknown} notification - notification 参数。
     * @returns {unknown} 返回处理后的结果。
     */
    onNotification(notification) {
      notifications.push(notification);
    }
  });

  await server.handle(createRpcRequest(APP_SERVER_METHODS.INITIALIZE, {}, 1));

  const pending = server.serverRequests.create(createPermissionsApprovalServerRequest({
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "call-1",
    environmentId: "local",
    cwd: "/workspace",
    reason: "Need workspace write access",
    permissions: {
      network: {
        enabled: true
      },
      fileSystem: {
        write: ["/workspace", "/tmp"]
      }
    }
  }));

  assert.equal(serverRequests.length, 1);
  assert.equal(serverRequests[0].method, "item/permissions/requestApproval");
  assert.equal(serverRequests[0].params.cwd, "/workspace");

  const resolved = await server.handle(createRpcRequest(APP_SERVER_METHODS.SERVER_REQUEST_RESOLVE, {
    requestId: pending.requestId,
    response: {
      permissions: {
        network: {
          enabled: true
        },
        fileSystem: {
          write: ["/workspace", "/secret"]
        }
      },
      scope: "session"
    }
  }, 2));

  assert.equal(resolved.result.request.requestId, pending.requestId);
  assert.equal(notifications.some((entry) => entry.method === APP_SERVER_NOTIFICATIONS.SERVER_REQUEST_RESOLVED), true);

  const grants = permissionGrantStore.list({
    threadId: "thread-1",
    scope: "session"
  });

  assert.equal(grants.length, 1);
  assert.deepEqual(grants[0].permissions, {
    network: {
      enabled: true
    },
    fileSystem: {
      write: ["/workspace"]
    }
  });
});

/**
 * 等待 wait for app server session output 相关数据。
 *
 * 这是异步流程，调用方需要等待 Promise 完成。
 *
 * @param {unknown} server - server 参数。
 * @param {unknown} sessionId - sessionId 参数。
 * @param {unknown} pattern - pattern 参数。
 * @returns {unknown} 返回处理后的结果。
 */
async function waitForAppServerSessionOutput(server, sessionId, pattern) {
  for (let index = 0; index < 50; index += 1) {
    const session = server.commandSessionManager.get(sessionId);
    const output = session
      ? Buffer.concat([
          ...(session.stdoutChunks ?? []),
          ...(session.stderrChunks ?? [])
        ]).toString("utf8")
      : "";

    if (pattern.test(session?.output ?? output)) {
      return session;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`session ${sessionId} did not produce expected output`);
}

/**
 * 等待 wait for notification 相关数据。
 *
 * 这是异步流程，调用方需要等待 Promise 完成。
 *
 * @param {unknown} notifications - notifications 参数。
 * @param {unknown} method - method 参数。
 * @returns {unknown} 返回处理后的结果。
 */
async function waitForNotification(notifications, method) {
  for (let index = 0; index < 50; index += 1) {
    const notification = notifications.find((entry) => entry.method === method);

    if (notification) {
      return notification;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`notification not received: ${method}`);
}

/**
 * 创建 create writable capture 相关数据。
 * @returns {unknown} 返回处理后的结果。
 */
function createWritableCapture() {
  return {
    text: "",
    /**
     * 写入 write 相关数据。
     *
     * @param {unknown} chunk - chunk 参数。
     * @returns {unknown} 返回处理后的结果。
     */
    write(chunk) {
      this.text += String(chunk);
      return true;
    }
  };
}
