import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  APPROVAL_DECISIONS,
  ApprovalGate,
  LoopingTurnRuntime,
  RealApplyPatchFsRuntime,
  SafeToolCallRuntime,
  createNodeApplyPatchFileProvider,
  createScriptedModelClient,
  createTurnContext
} from "../src/index.js";

test("agent turn can search, read, preview a patch, and finish with tool context", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "codex-js-e2e-preview-"));

  try {
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(path.join(workspace, "src", "app.txt"), "alpha\nTODO: replace me\nomega\n", "utf8");

    const modelClient = createScriptedModelClient([
      [
        {
          type: "function_call",
          callId: "search-1",
          name: "search_files",
          arguments: {
            query: "TODO",
            path: "."
          }
        }
      ],
      [
        {
          type: "function_call",
          callId: "read-1",
          name: "read_file",
          arguments: {
            path: "src/app.txt"
          }
        }
      ],
      [
        {
          type: "function_call",
          callId: "patch-1",
          name: "apply_patch",
          arguments: {
            patch: `*** Begin Patch
*** Update File: src/app.txt
@@
-TODO: replace me
+done
*** End Patch`
          }
        }
      ],
      [
        {
          text: "previewed change"
        }
      ]
    ]);
    const runtime = new LoopingTurnRuntime({
      modelClient,
      toolRuntime: new SafeToolCallRuntime({
        allowApplyPatch: true,
        workingDirectory: workspace,
        applyPatchFileProvider: createNodeApplyPatchFileProvider()
      })
    });
    const events = [];

    for await (const event of runtime.runTurn(createTurnContext({
      input: "Find the TODO and prepare a patch.",
      workingDirectory: workspace
    }))) {
      events.push(event);
    }

    const toolResults = events.filter((event) => (
      event.type === "item.completed" &&
      event.item?.type === "tool_result"
    ));

    assert.equal(toolResults.length, 3);
    assert.match(toolResults[0].item.output, /src[/\\]app\.txt:2: TODO: replace me/);
    assert.match(toolResults[1].item.output, /TODO: replace me/);
    assert.match(toolResults[2].item.output, /patch was not applied/);
    assert.equal(await readFile(path.join(workspace, "src", "app.txt"), "utf8"), "alpha\nTODO: replace me\nomega\n");
    assert.equal(modelClient.lastSession.prompts.length, 4);
    assert.equal(modelClient.lastSession.prompts[1].responseInputItems.length, 1);
    assert.equal(modelClient.lastSession.prompts[2].responseInputItems.length, 2);
    assert.equal(modelClient.lastSession.prompts[3].responseInputItems.length, 3);
    assert.equal(events.at(-2).item.content[0].text, "previewed change");
    assert.equal(events.at(-1).type, "turn.completed");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("agent turn blocks apply_patch writes when approval prompts", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "codex-js-e2e-block-"));

  try {
    await writeFile(path.join(workspace, "note.txt"), "old\n", "utf8");

    const modelClient = createScriptedModelClient([
      [
        {
          type: "function_call",
          callId: "patch-1",
          name: "apply_patch",
          arguments: {
            patch: `*** Begin Patch
*** Update File: note.txt
@@
-old
+new
*** End Patch`
          }
        }
      ],
      [
        {
          text: "write was blocked"
        }
      ]
    ]);
    const runtime = new LoopingTurnRuntime({
      modelClient,
      toolRuntime: new SafeToolCallRuntime({
        allowApplyPatchWrites: true,
        approvalGate: new ApprovalGate({
          defaultDecision: APPROVAL_DECISIONS.PROMPT
        }),
        applyPatchFileProvider: createNodeApplyPatchFileProvider(),
        applyPatchFsRuntime: new RealApplyPatchFsRuntime({
          allowWrites: true
        }),
        workingDirectory: workspace
      })
    });
    const events = [];

    for await (const event of runtime.runTurn(createTurnContext({
      input: "Apply this change.",
      workingDirectory: workspace
    }))) {
      events.push(event);
    }

    const toolResult = events.find((event) => (
      event.type === "item.completed" &&
      event.item?.type === "tool_result"
    ));

    assert.equal(toolResult.item.status, "failed");
    assert.equal(toolResult.item.error, "blocked: prompt");
    assert.match(toolResult.item.output, /apply_patch blocked: prompt/);
    assert.equal(await readFile(path.join(workspace, "note.txt"), "utf8"), "old\n");
    assert.equal(events.at(-2).item.content[0].text, "write was blocked");
    assert.equal(events.at(-1).type, "turn.completed");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("agent turn can apply a patch when writes and approval are explicitly allowed", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "codex-js-e2e-apply-"));

  try {
    await writeFile(path.join(workspace, "note.txt"), "old\n", "utf8");

    const modelClient = createScriptedModelClient([
      [
        {
          type: "function_call",
          callId: "patch-1",
          name: "apply_patch",
          arguments: {
            patch: `*** Begin Patch
*** Update File: note.txt
@@
-old
+new
*** End Patch`
          }
        }
      ],
      [
        {
          text: "write applied"
        }
      ]
    ]);
    const runtime = new LoopingTurnRuntime({
      modelClient,
      toolRuntime: new SafeToolCallRuntime({
        allowApplyPatchWrites: true,
        approvalGate: new ApprovalGate({
          defaultDecision: APPROVAL_DECISIONS.ALLOW
        }),
        applyPatchFileProvider: createNodeApplyPatchFileProvider(),
        applyPatchFsRuntime: new RealApplyPatchFsRuntime({
          allowWrites: true
        }),
        workingDirectory: workspace
      })
    });
    const events = [];

    for await (const event of runtime.runTurn(createTurnContext({
      input: "Apply this change.",
      workingDirectory: workspace
    }))) {
      events.push(event);
    }

    const toolResult = events.find((event) => (
      event.type === "item.completed" &&
      event.item?.type === "tool_result"
    ));

    assert.equal(toolResult.item.status, "completed");
    assert.match(toolResult.item.output, /Success\. Updated the following files:/);
    assert.equal(await readFile(path.join(workspace, "note.txt"), "utf8"), "new\n");
    assert.equal(events.at(-2).item.content[0].text, "write applied");
    assert.equal(events.at(-1).type, "turn.completed");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
