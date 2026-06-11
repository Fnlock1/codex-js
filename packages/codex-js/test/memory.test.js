import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BUILTIN_TOOL_NAMES,
  Codex,
  LoopingTurnRuntime,
  MemoryStore,
  MockModelClient,
  SafeToolCallRuntime
} from "../src/index.js";

/**
 * 创建测试专用的临时记忆存储。
 *
 * @returns {Promise<{dir: string, store: MemoryStore, cleanup: Function}>} 测试上下文。
 */
async function createTempMemoryStore() {
  const dir = await mkdtemp(join(tmpdir(), "codex-js-memory-"));
  const store = new MemoryStore({
    memoryStoreDirectory: dir
  });

  return {
    dir,
    store,
    cleanup: async () => {
      await rm(dir, {
        recursive: true,
        force: true
      });
    }
  };
}

test("MemoryStore saves, recalls, and forgets scoped memories", async () => {
  const { store, cleanup } = await createTempMemoryStore();

  try {
    const memory = await store.remember({
      text: "用户希望 agent 设计修改从 packages/codex-js/src/thread.js 入手。",
      scope: "project",
      workingDirectory: process.cwd(),
      tags: ["agent", "design"]
    });

    await store.remember({
      text: "完全无关的颜色偏好。",
      scope: "project",
      workingDirectory: process.cwd()
    });

    const recalled = await store.recall("agent 设计 从哪里改", {
      workingDirectory: process.cwd(),
      limit: 3
    });

    assert.equal(recalled.length, 1);
    assert.equal(recalled[0].id, memory.id);
    assert.match(recalled[0].text, /agent/);

    const forgotten = await store.forget(memory.id);
    assert.equal(forgotten.id, memory.id);

    const afterForget = await store.recall("agent 设计", {
      workingDirectory: process.cwd()
    });

    assert.equal(afterForget.length, 0);
  } finally {
    await cleanup();
  }
});

test("MemoryStore keeps expert-private memories isolated", async () => {
  const { store, cleanup } = await createTempMemoryStore();

  try {
    await store.remember({
      text: "播放器专家记住：视频卡片点击后要打开播放弹窗。",
      scope: "project",
      workingDirectory: process.cwd(),
      expertId: "video_playback"
    });
    await store.remember({
      text: "架构专家记住：页面数据结构要分离配置和渲染。",
      scope: "project",
      workingDirectory: process.cwd(),
      expertId: "architect"
    });
    await store.remember({
      text: "共享记忆：B 站风格页面需要顶部导航。",
      scope: "project",
      workingDirectory: process.cwd()
    });

    const videoMemories = await store.recall("视频 页面", {
      workingDirectory: process.cwd(),
      expertId: "video_playback"
    });
    const architectMemories = await store.recall("视频 页面", {
      workingDirectory: process.cwd(),
      expertId: "architect"
    });
    const leaderMemories = await store.recall("视频 页面", {
      workingDirectory: process.cwd()
    });

    assert.equal(videoMemories.some((memory) => memory.expertId === "video_playback"), true);
    assert.equal(videoMemories.some((memory) => memory.expertId === "architect"), false);
    assert.equal(architectMemories.some((memory) => memory.expertId === "video_playback"), false);
    assert.equal(leaderMemories.some((memory) => memory.expertId), false);
  } finally {
    await cleanup();
  }
});

test("SafeToolCallRuntime exposes memory tools through handlers", async () => {
  const { store, cleanup } = await createTempMemoryStore();

  try {
    const runtime = new SafeToolCallRuntime({
      memoryStore: store,
      workingDirectory: process.cwd()
    });

    const remember = await runtime.run({
      call_id: "remember-1",
      name: BUILTIN_TOOL_NAMES.REMEMBER,
      arguments: {
        text: "项目里 memory 工具入口在 tools/builtins.js 和 tools/handlers.js。",
        scope: "project"
      }
    }, {
      turnContext: {
        threadId: "thread-test",
        workingDirectory: process.cwd(),
        inputText: () => "memory 工具在哪里"
      }
    });

    assert.equal(remember.status, "completed");
    const visibleToolNames = runtime.router.modelVisibleSpecs().map((spec) => spec.name);

    assert.ok(visibleToolNames.includes(BUILTIN_TOOL_NAMES.REMEMBER));
    assert.ok(visibleToolNames.includes(BUILTIN_TOOL_NAMES.RECALL_MEMORY));

    const recall = await runtime.run({
      call_id: "recall-1",
      name: BUILTIN_TOOL_NAMES.RECALL_MEMORY,
      arguments: {
        query: "memory 工具入口"
      }
    }, {
      turnContext: {
        threadId: "thread-test",
        workingDirectory: process.cwd(),
        inputText: () => "memory 工具入口"
      }
    });

    const payload = JSON.parse(recall.output);

    assert.equal(recall.status, "completed");
    assert.equal(payload.memories.length, 1);
    assert.match(payload.context, /Relevant long-term memories/);
  } finally {
    await cleanup();
  }
});

test("memory tools default to the current expert namespace", async () => {
  const { store, cleanup } = await createTempMemoryStore();

  try {
    const runtime = new SafeToolCallRuntime({
      memoryStore: store,
      workingDirectory: process.cwd()
    });
    const turnContext = {
      threadId: "thread-video",
      workingDirectory: process.cwd(),
      metadata: {
        memory: {
          expertId: "video_playback"
        }
      },
      inputText: () => "视频播放记忆"
    };

    const remember = await runtime.run({
      call_id: "remember-expert",
      name: BUILTIN_TOOL_NAMES.REMEMBER,
      arguments: {
        text: "视频播放专家偏好 Canvas 模拟播放态。",
        scope: "project"
      }
    }, {
      turnContext
    });
    const recall = await runtime.run({
      call_id: "recall-expert",
      name: BUILTIN_TOOL_NAMES.RECALL_MEMORY,
      arguments: {
        query: "Canvas 播放"
      }
    }, {
      turnContext
    });
    const payload = JSON.parse(recall.output);

    assert.equal(remember.status, "completed");
    assert.equal(JSON.parse(remember.output).memory.expertId, "video_playback");
    assert.equal(payload.memories.length, 1);
    assert.equal(payload.memories[0].expertId, "video_playback");
  } finally {
    await cleanup();
  }
});

test("Thread injects recalled memories into model prompt", async () => {
  const { store, cleanup } = await createTempMemoryStore();

  try {
    await store.remember({
      text: "用户正在设计 agent memory，需要从 MemoryStore、工具入口、prompt 注入三处修改。",
      scope: "project",
      workingDirectory: process.cwd()
    });

    const modelClient = new MockModelClient({
      mockResponse: "ok"
    });
    const runtime = new LoopingTurnRuntime({
      modelClient
    });
    const codex = new Codex({
      workingDirectory: process.cwd(),
      memoryStore: store,
      runtime
    });

    await codex.startThread().run("agent memory prompt 注入怎么改");

    const prompt = modelClient.lastSession.prompts[0];

    assert.equal(prompt.memories.length, 1);
    assert.match(prompt.memoryContextText, /MemoryStore/);
  } finally {
    await cleanup();
  }
});
