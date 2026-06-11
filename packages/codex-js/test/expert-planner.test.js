import assert from "node:assert/strict";
import test from "node:test";
import {
  formatExpertPlan,
  planExperts
} from "../src/index.js";

test("expert planner prefers fullstack for simple implementation tasks", () => {
  const plan = planExperts({
    task: "帮我写一个 B 站风格官网 HTML 页面，可以看视频",
    limit: 4
  });
  const expertIds = plan.assignments.map((assignment) => assignment.expert.id);

  assert.equal(plan.task, "帮我写一个 B 站风格官网 HTML 页面，可以看视频");
  assert.equal(expertIds[0], "fullstack");
  assert.equal(expertIds.includes("backend"), false);
  assert.equal(plan.spawnSequence.length, plan.assignments.length);
  assert.equal(plan.waitSequence.length, plan.assignments.length);
  assert.match(plan.summaryPrompt, /最终只输出中文摘要/);
});

test("expert planner splits frontend and backend for complex full-stack tasks", () => {
  const plan = planExperts({
    task: "实现一个完整 Vue 前端加 Node 后端 API 的登录系统，包含数据库、鉴权、权限和测试",
    limit: 5
  });
  const expertIds = plan.assignments.map((assignment) => assignment.expert.id);

  assert.equal(expertIds.includes("frontend"), true);
  assert.equal(expertIds.includes("backend"), true);
  assert.equal(expertIds.includes("architect"), true);
  assert.equal(expertIds.includes("tester"), true);
  assert.equal(expertIds.includes("fullstack"), false);
});

test("expert planner honors explicit experts before auto selection", () => {
  const plan = planExperts({
    task: "实现 MemoryStore recall prompt 注入，并检查工具入口",
    experts: ["memory", "tools"],
    limit: 3
  });
  const expertIds = plan.assignments.map((assignment) => assignment.expert.id);

  assert.equal(expertIds[0], "memory");
  assert.equal(expertIds[1], "tools");
  assert.equal(expertIds.length, 3);
});

test("expert planner can use dynamically created experts", () => {
  const plan = planExperts({
    task: "设计视频播放官网，需要播放器体验专家",
    experts: ["video_playback"],
    customExperts: [
      {
        id: "video_playback",
        name: "视频播放体验专家",
        role: "video_playback_expert",
        description: "负责视频播放交互、弹窗、进度条和试看体验。",
        prompt: "AI 生成动态专家提示词：你专门评估视频播放体验，必须关注播放入口、试看、弹窗和状态反馈。",
        instructions: ["优先检查播放流程。"],
        keywords: ["video", "视频", "播放器"]
      }
    ],
    limit: 2
  });

  assert.equal(plan.assignments[0].expert.id, "video_playback");
  assert.equal(plan.assignments[0].expert.name, "视频播放体验专家");
  assert.equal(plan.dynamicExperts[0].id, "video_playback");
  assert.match(plan.dynamicExperts[0].prompt, /AI 生成动态专家提示词/);
  assert.match(plan.spawnSequence[0].arguments.expert_profile.prompt, /AI 生成动态专家提示词/);
  assert.match(plan.assignments[0].task, /动态专家角色/);
});

test("expert planner formats a readable plan for the coordinator model", () => {
  const plan = planExperts({
    task: "检查 shell 工具权限风险",
    experts: ["security"],
    limit: 2
  });
  const text = formatExpertPlan(plan);

  assert.match(text, /Strategy:/);
  assert.match(text, /Assignments:/);
  assert.match(text, /security/);
  assert.match(text, /Summary:/);
});

test("expert planner rejects empty tasks", () => {
  assert.throws(
    () => planExperts({
      task: "  "
    }),
    /non-empty task/
  );
});
