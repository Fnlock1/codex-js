import assert from "node:assert/strict";
import test from "node:test";
import {
  formatExpertAgentPrompt,
  getExpertProfile,
  listDefaultExpertProfiles,
  selectExpertProfile
} from "../src/index.js";

test("expert profiles can be listed and selected explicitly", () => {
  const profiles = listDefaultExpertProfiles();
  const fullstack = getExpertProfile("fullstack", profiles);
  const backend = getExpertProfile("backend", profiles);
  const tester = getExpertProfile("tester", profiles);
  const selected = selectExpertProfile({
    expert: "tester",
    task: "检查 memory 代码"
  });

  assert.ok(profiles.length > 0);
  assert.equal(fullstack.role, "fullstack_engineer");
  assert.equal(backend.role, "backend_engineer");
  assert.equal(tester.id, "tester");
  assert.equal(selected.id, "tester");
});

test("expert profiles auto-select from task keywords", () => {
  const memory = selectExpertProfile({
    task: "实现 MemoryStore recall prompt 注入"
  });
  const security = selectExpertProfile({
    task: "检查 sandbox permission secret 泄露风险"
  });

  assert.equal(memory.id, "memory");
  assert.equal(security.id, "security");
});

test("expert profiles auto-select fullstack and backend from task keywords", () => {
  const fullstack = selectExpertProfile({
    task: "创建一个 Vue 官网页面并接一点本地数据"
  });
  const backend = selectExpertProfile({
    task: "实现后端 API 数据库登录鉴权"
  });

  assert.equal(fullstack.id, "fullstack");
  assert.equal(backend.id, "backend");
});

test("expert agent prompt includes expert role and task", () => {
  const prompt = formatExpertAgentPrompt({
    task: "分析工具系统 schema",
    metadata: {
      expert: selectExpertProfile({
        expert: "tools"
      }),
      context: "已有 tools/runtime.js"
    }
  });

  assert.match(prompt, /工具系统专家/);
  assert.match(prompt, /tooling_expert/);
  assert.match(prompt, /分析工具系统 schema/);
  assert.match(prompt, /已有 tools\/runtime\.js/);
  assert.match(prompt, /technical leader/);
  assert.match(prompt, /Do not communicate/);
});

test("dynamic expert prompt uses AI-generated prompt body", () => {
  const prompt = formatExpertAgentPrompt({
    task: "审查视频播放弹窗",
    metadata: {
      expert: {
        id: "video_playback",
        name: "视频播放体验专家",
        role: "video_playback_expert",
        description: "负责视频体验。",
        dynamic: true,
        prompt: "AI 生成动态专家提示词：你只评估视频播放体验、状态反馈和弹窗交互。"
      }
    }
  });

  assert.match(prompt, /AI 生成动态专家提示词/);
  assert.match(prompt, /审查视频播放弹窗/);
  assert.match(prompt, /technical leader/);
  assert.doesNotMatch(prompt, /Focus: 负责视频体验/);
});
