import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  BlockedApplyPatchFsRuntime,
  RealApplyPatchFsRuntime,
  SandboxPolicy,
  SANDBOX_MODES,
  applyApplyPatchPlan,
  ApplyPatchParseError,
  computeApplyPatchPlan,
  createApplyPatchApplyFromText,
  createApplyPatchPlanFromText,
  createApplyPatchDryRunFromText,
  createNodeApplyPatchFileProvider,
  deriveNewContentsFromChunks,
  formatApplyPatchSuccessOutput,
  normalizeApplyPatchText,
  parseApplyPatch,
  resolvePatchPath,
  seekSequence,
  summarizeApplyPatch
} from "../src/index.js";

test("parseApplyPatch parses add file hunks", () => {
  const parsed = parseApplyPatch(`*** Begin Patch
*** Add File: README.md
+hello
+world
*** End Patch`);

  assert.equal(parsed.hunks[0].type, "add_file");
  assert.equal(parsed.hunks[0].path, "README.md");
  assert.equal(parsed.hunks[0].contents, "hello\nworld");
  assert.deepEqual(parsed.summary, {
    add: 1,
    delete: 0,
    update: 0,
    move: 0,
    files: ["README.md"]
  });
});

test("parseApplyPatch accepts lenient model create-file patches", () => {
  const parsed = parseApplyPatch(`*** Begin Patch
Create a new file: index.html

Replace content:
<!DOCTYPE html>
<html lang="zh-CN">
<body>Hello</body>
</html>
ENDOFFILE
echo "File created successfully"`);

  assert.equal(parsed.patch, `*** Begin Patch
*** Add File: index.html
+<!DOCTYPE html>
+<html lang="zh-CN">
+<body>Hello</body>
+</html>
*** End Patch`);
  assert.equal(parsed.hunks[0].type, "add_file");
  assert.equal(parsed.hunks[0].path, "index.html");
  assert.equal(parsed.hunks[0].contents, "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<body>Hello</body>\n</html>");
});

test("parseApplyPatch parses delete file hunks", () => {
  const parsed = parseApplyPatch(`*** Begin Patch
*** Delete File: old.txt
*** End Patch`);

  assert.equal(parsed.hunks[0].type, "delete_file");
  assert.equal(parsed.hunks[0].path, "old.txt");
  assert.equal(parsed.summary.delete, 1);
});

test("parseApplyPatch parses update hunks with context and EOF", () => {
  const parsed = parseApplyPatch(`*** Begin Patch
*** Update File: src/app.js
@@ function main()
-old
+new
 context
*** End of File
*** End Patch`);
  const chunk = parsed.hunks[0].chunks[0];

  assert.equal(parsed.hunks[0].type, "update_file");
  assert.equal(chunk.changeContext, "function main()");
  assert.deepEqual(chunk.oldLines, ["old", "context"]);
  assert.deepEqual(chunk.newLines, ["new", "context"]);
  assert.equal(chunk.isEndOfFile, true);
});

test("parseApplyPatch parses move hunks", () => {
  const parsed = parseApplyPatch(`*** Begin Patch
*** Update File: old.js
*** Move to: new.js
@@
-old
+new
*** End Patch`);

  assert.equal(parsed.hunks[0].movePath, "new.js");
  assert.equal(parsed.summary.move, 1);
  assert.deepEqual(parsed.summary.files, ["old.js", "new.js"]);
});

test("normalizeApplyPatchText strips heredoc wrappers", () => {
  const text = normalizeApplyPatchText(`<<'EOF'
*** Begin Patch
*** Delete File: old.txt
*** End Patch
EOF`);

  assert.equal(text.startsWith("*** Begin Patch"), true);
  assert.equal(parseApplyPatch(text).summary.delete, 1);
});

test("parseApplyPatch rejects invalid patches", () => {
  assert.throws(
    () => parseApplyPatch("*** End Patch"),
    ApplyPatchParseError
  );
  assert.throws(
    () => parseApplyPatch(`*** Begin Patch
*** Update File: empty.txt
*** End Patch`),
    /empty/
  );
  assert.throws(
    () => parseApplyPatch(`*** Begin Patch
*** End Patch`),
    /expected at least one hunk/
  );
});

test("createApplyPatchDryRunFromText returns completed dry-run result", () => {
  const result = createApplyPatchDryRunFromText(`*** Begin Patch
*** Add File: README.md
+hello
*** End Patch`);

  assert.equal(result.status, "completed");
  assert.equal(result.raw.dry_run, true);
  assert.equal(result.raw.apply_patch.summary.add, 1);
  assert.match(result.output, /patch was not applied/);
});

test("createApplyPatchDryRunFromText returns parse failures", () => {
  const result = createApplyPatchDryRunFromText("bad patch");

  assert.equal(result.status, "failed");
  assert.equal(result.error, "parse_error");
  assert.equal(result.raw.apply_patch.parse_error.line_number, 1);
});

test("summarizeApplyPatch includes hunk count and environment id", () => {
  const parsed = parseApplyPatch(`*** Begin Patch
*** Environment ID: env-1
*** Delete File: old.txt
*** End Patch`);
  const summary = summarizeApplyPatch(parsed);

  assert.equal(summary.hunk_count, 1);
  assert.equal(summary.environment_id, "env-1");
});

test("deriveNewContentsFromChunks applies replacements and preserves trailing newline", () => {
  const parsed = parseApplyPatch(`*** Begin Patch
*** Update File: src/app.js
@@
 hello
-old
+new
*** End Patch`);
  const result = deriveNewContentsFromChunks("hello\nold\nbye\n", parsed.hunks[0].chunks, "src/app.js");

  assert.equal(result.newContent, "hello\nnew\nbye\n");
  assert.deepEqual(result.replacements, [
    {
      start: 0,
      oldLength: 2,
      newLines: ["hello", "new"]
    }
  ]);
});

test("deriveNewContentsFromChunks handles EOF pure additions", () => {
  const parsed = parseApplyPatch(`*** Begin Patch
*** Update File: src/app.js
@@
+tail
*** End of File
*** End Patch`);
  const result = deriveNewContentsFromChunks("head\n", parsed.hunks[0].chunks, "src/app.js");

  assert.equal(result.newContent, "head\ntail\n");
});

test("seekSequence uses fuzzy unicode punctuation matching", () => {
  assert.equal(
    seekSequence(
      ["import asyncio  # local import \u2013 avoids top\u2011level dep"],
      ["import asyncio  # local import - avoids top-level dep"],
      0,
      false
    ),
    0
  );
});

test("computeApplyPatchPlan computes add, delete, update, and move changes", async () => {
  const parsed = parseApplyPatch(`*** Begin Patch
*** Add File: added.txt
+created
*** Delete File: deleted.txt
*** Update File: source.txt
*** Move to: moved.txt
@@
-old
+new
*** End Patch`);
  const plan = await computeApplyPatchPlan(parsed, {
    workingDirectory: "/workspace",
    fileProvider: {
      "deleted.txt": "bye\n",
      "source.txt": "old\n"
    }
  });

  assert.equal(plan.dryRun, true);
  assert.equal(plan.changes.length, 3);
  assert.deepEqual(plan.affected.added, ["added.txt"]);
  assert.deepEqual(plan.affected.deleted, ["deleted.txt"]);
  assert.deepEqual(plan.affected.modified, ["moved.txt"]);
  assert.equal(plan.changes[0].content, "created");
  assert.equal(plan.changes[1].content, "bye\n");
  assert.equal(plan.changes[2].oldContent, "old\n");
  assert.equal(plan.changes[2].newContent, "new\n");
  assert.match(plan.changes[2].absolutePath.replace(/\\/g, "/"), /\/workspace\/source\.txt$/);
  assert.match(plan.changes[2].absoluteMovePath.replace(/\\/g, "/"), /\/workspace\/moved\.txt$/);
});

test("computeApplyPatchPlan rejects missing update files and mismatched hunks", async () => {
  const missingFile = parseApplyPatch(`*** Begin Patch
*** Update File: missing.txt
@@
-old
+new
*** End Patch`);
  await assert.rejects(
    () => computeApplyPatchPlan(missingFile, {
      workingDirectory: "/workspace",
      fileProvider: {}
    }),
    /failed to read file to update/
  );

  const mismatched = parseApplyPatch(`*** Begin Patch
*** Update File: file.txt
@@
-old
+new
*** End Patch`);
  await assert.rejects(
    () => computeApplyPatchPlan(mismatched, {
      workingDirectory: "/workspace",
      fileProvider: {
        "file.txt": "different\n"
      }
    }),
    /failed to find expected lines/
  );
});

test("computeApplyPatchPlan respects sandbox write policy", async () => {
  const parsed = parseApplyPatch(`*** Begin Patch
*** Add File: README.md
+hello
*** End Patch`);

  await assert.rejects(
    () => computeApplyPatchPlan(parsed, {
      workingDirectory: "/workspace",
      fileProvider: {},
      sandboxPolicy: new SandboxPolicy({
        mode: SANDBOX_MODES.READ_ONLY,
        workingDirectory: "/workspace"
      })
    }),
    /write outside sandbox roots/
  );

  const plan = await computeApplyPatchPlan(parsed, {
    workingDirectory: "/workspace",
    fileProvider: {},
    sandboxPolicy: new SandboxPolicy({
      mode: SANDBOX_MODES.WORKSPACE_WRITE,
      workingDirectory: "/workspace"
    })
  });

  assert.equal(plan.changes[0].path, "README.md");
});

test("resolvePatchPath blocks absolute and escaping paths", () => {
  assert.throws(
    () => resolvePatchPath("/tmp/file.txt", {
      workingDirectory: "/workspace"
    }),
    /absolute/
  );
  assert.throws(
    () => resolvePatchPath("../file.txt", {
      workingDirectory: "/workspace"
    }),
    /escapes/
  );
});

test("createApplyPatchPlanFromText returns dry-run plan results without writing files", async () => {
  const result = await createApplyPatchPlanFromText(`*** Begin Patch
*** Update File: README.md
@@
-old
+new
*** End Patch`, {
    workingDirectory: "/workspace",
    fileProvider: {
      "README.md": "old\n"
    }
  });

  assert.equal(result.status, "completed");
  assert.equal(result.raw.dry_run, true);
  assert.equal(result.raw.apply_patch.plan.changes[0].newContent, "new\n");
  assert.match(result.output, /plan computed successfully/);
  assert.match(result.output, /patch was not applied/);
});

test("BlockedApplyPatchFsRuntime refuses to write computed plans", async () => {
  const parsed = parseApplyPatch(`*** Begin Patch
*** Add File: blocked.txt
+blocked
*** End Patch`);
  const plan = await computeApplyPatchPlan(parsed, {
    workingDirectory: "/workspace",
    fileProvider: {}
  });
  const result = await new BlockedApplyPatchFsRuntime().run(plan);

  assert.equal(result.applied, false);
  assert.equal(result.dry_run, true);
  assert.equal(result.error, "writes_not_allowed");
  assert.match(result.output, /not allowed/);
});

test("RealApplyPatchFsRuntime applies add, update, delete, and move plans in a temp directory", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-js-apply-"));

  try {
    await writeFile(path.join(dir, "delete.txt"), "delete me\n", "utf8");
    await writeFile(path.join(dir, "source.txt"), "old\n", "utf8");
    const parsed = parseApplyPatch(`*** Begin Patch
*** Add File: nested/added.txt
+created
*** Delete File: delete.txt
*** Update File: source.txt
*** Move to: moved.txt
@@
-old
+new
*** End Patch`);
    const plan = await computeApplyPatchPlan(parsed, {
      workingDirectory: dir,
      fileProvider: createNodeApplyPatchFileProvider()
    });
    const result = await new RealApplyPatchFsRuntime({
      allowWrites: true
    }).run(plan);

    assert.equal(result.applied, true);
    assert.equal(result.error, null);
    assert.equal(await readFile(path.join(dir, "nested", "added.txt"), "utf8"), "created");
    await assert.rejects(
      () => readFile(path.join(dir, "delete.txt"), "utf8"),
      /ENOENT/
    );
    await assert.rejects(
      () => readFile(path.join(dir, "source.txt"), "utf8"),
      /ENOENT/
    );
    assert.equal(await readFile(path.join(dir, "moved.txt"), "utf8"), "new\n");
    assert.equal(formatApplyPatchSuccessOutput(plan), [
      "Success. Updated the following files:",
      "A nested/added.txt",
      "M moved.txt",
      "D delete.txt"
    ].join("\n"));
  } finally {
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
});

test("applyApplyPatchPlan requires explicit write permission", async () => {
  const parsed = parseApplyPatch(`*** Begin Patch
*** Add File: blocked.txt
+blocked
*** End Patch`);
  const plan = await computeApplyPatchPlan(parsed, {
    workingDirectory: "/workspace",
    fileProvider: {}
  });

  await assert.rejects(
    () => applyApplyPatchPlan(plan),
    /writes are not allowed/
  );
});

test("createApplyPatchApplyFromText blocks writes by default and applies only with allowWrites", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-js-apply-text-"));
  const patch = `*** Begin Patch
*** Add File: created.txt
+created
*** End Patch`;

  try {
    const blocked = await createApplyPatchApplyFromText(patch, {
      workingDirectory: dir
    });

    assert.equal(blocked.status, "failed");
    assert.equal(blocked.error, "writes_not_allowed");
    await assert.rejects(
      () => readFile(path.join(dir, "created.txt"), "utf8"),
      /ENOENT/
    );

    const applied = await createApplyPatchApplyFromText(patch, {
      workingDirectory: dir,
      allowWrites: true
    });

    assert.equal(applied.status, "completed");
    assert.equal(applied.raw.dry_run, false);
    assert.equal(await readFile(path.join(dir, "created.txt"), "utf8"), "created");
  } finally {
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
});

test("createApplyPatchApplyFromText writes lenient model create-file patches", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-js-apply-lenient-"));
  const patch = `*** Begin Patch
Create file: index.html

Content:
<!doctype html>
<title>Created</title>
ENDOFFILE
echo "ignored"`;

  try {
    const applied = await createApplyPatchApplyFromText(patch, {
      workingDirectory: dir,
      allowWrites: true
    });

    assert.equal(applied.status, "completed");
    assert.equal(await readFile(path.join(dir, "index.html"), "utf8"), "<!doctype html>\n<title>Created</title>");
  } finally {
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
});
