import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  Codex,
  SessionStore
} from "../src/index.js";

test("SessionStore lists stored sessions from disk with pagination and filters", async () => {
  const sessionStoreDirectory = await mkdtemp(join(tmpdir(), "codex-js-store-list-"));

  try {
    const codex = new Codex({
      sessionStoreDirectory,
      mockResponse: "done"
    });
    const first = codex.startThread({
      workingDirectory: sessionStoreDirectory
    });
    const second = codex.startThread({
      workingDirectory: sessionStoreDirectory
    });

    await first.run("alpha");
    await second.run("beta");

    const store = new SessionStore({
      sessionStoreDirectory
    });
    const page = await store.list({
      limit: 1
    });

    assert.equal(page.sessions.length, 1);
    assert.equal(typeof page.nextCursor, "string");

    const searched = await store.list({
      searchTerm: "alpha"
    });

    assert.equal(searched.sessions.length, 1);
    assert.equal(searched.sessions[0].threadId, first.id);
  } finally {
    await rm(sessionStoreDirectory, {
      recursive: true,
      force: true
    });
  }
});

test("SessionStore archives, unarchives, forks, rolls back, and patches metadata", async () => {
  const sessionStoreDirectory = await mkdtemp(join(tmpdir(), "codex-js-store-manage-"));

  try {
    const codex = new Codex({
      sessionStoreDirectory,
      mockResponse: "done"
    });
    const thread = codex.startThread({
      workingDirectory: sessionStoreDirectory
    });
    await thread.run("first");
    await thread.run("second");

    const store = new SessionStore({
      sessionStoreDirectory
    });
    const archived = await store.archive(thread.id);

    assert.equal(archived.archived, true);
    assert.equal((await store.list()).sessions.length, 0);
    assert.equal((await store.list({
      archived: true
    })).sessions[0].threadId, thread.id);

    const restored = await store.unarchive(thread.id);
    assert.equal(restored.archived, false);

    const forked = await store.fork(thread.id);
    assert.notEqual(forked.threadId, thread.id);
    assert.equal(forked.metadata.forkedFromId, thread.id);
    assert.equal(forked.turns.length, 2);

    const rolledBack = await store.rollback(thread.id, {
      dropLastTurns: 1
    });
    assert.equal(rolledBack.turns.length, 1);

    const metadata = await store.updateMetadata(thread.id, {
      title: "stored title"
    });
    assert.equal(metadata.metadata.title, "stored title");
  } finally {
    await rm(sessionStoreDirectory, {
      recursive: true,
      force: true
    });
  }
});
