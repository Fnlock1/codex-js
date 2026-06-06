import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createThreadId } from "./protocol/index.js";
import {
  injectResponseItemsToSession,
  normalizeSessionRecord,
  rollbackSessionTurns
} from "./session/history.js";

export class SessionStore {
  constructor(options = {}) {
    this.root = resolve(options.sessionStoreDirectory ?? defaultSessionStoreDirectory());
    this.archivedRoot = resolve(options.archivedSessionStoreDirectory ?? join(this.root, "archived"));
  }

  async load(threadId, options = {}) {
    try {
      const filePath = this.sessionPath(threadId, {
        archived: options.archived
      });
      const content = await readFile(filePath, "utf8");
      return attachSessionStoreMetadata(JSON.parse(content), {
        filePath,
        archived: Boolean(options.archived)
      });
    } catch (error) {
      if (error?.code === "ENOENT") {
        if (!options.archived && options.includeArchived) {
          return await this.load(threadId, {
            archived: true
          });
        }

        return null;
      }

      throw error;
    }
  }

  async save(session, options = {}) {
    const filePath = this.sessionPath(session.threadId, {
      archived: options.archived
    });
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(session, null, 2)}\n`, "utf8");
    return session;
  }

  async list(options = {}) {
    const archived = Boolean(options.archived);
    const directory = archived ? this.archivedRoot : this.root;
    const limit = clampLimit(options.limit ?? 50);
    const offset = decodeCursor(options.cursor);
    let entries = [];

    try {
      entries = await readdir(directory, {
        withFileTypes: true
      });
    } catch (error) {
      if (error?.code === "ENOENT") {
        return {
          sessions: [],
          nextCursor: null
        };
      }

      throw error;
    }

    const sessions = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      try {
        const filePath = join(directory, entry.name);
        const parsed = JSON.parse(await readFile(filePath, "utf8"));
        const session = attachSessionStoreMetadata(normalizeSessionRecord(parsed), {
          filePath,
          archived
        });

        if (matchesSessionListFilters(session, options)) {
          sessions.push(session);
        }
      } catch {
        continue;
      }
    }

    sessions.sort(compareSessionsNewestFirst);

    const page = sessions.slice(offset, offset + limit);
    const nextOffset = offset + page.length;

    return {
      sessions: page,
      nextCursor: nextOffset < sessions.length ? encodeCursor(nextOffset) : null
    };
  }

  async archive(threadId) {
    const session = await this.load(threadId);

    if (!session) {
      const archived = await this.load(threadId, {
        archived: true
      });

      if (archived) {
        return archived;
      }

      return null;
    }

    return await this.moveSession(threadId, {
      fromArchived: false,
      toArchived: true
    });
  }

  async unarchive(threadId) {
    const session = await this.load(threadId, {
      archived: true
    });

    if (!session) {
      return await this.load(threadId);
    }

    return await this.moveSession(threadId, {
      fromArchived: true,
      toArchived: false
    });
  }

  async fork(threadId, options = {}) {
    const source = await this.load(threadId, {
      includeArchived: true
    });

    if (!source) {
      return null;
    }

    const now = new Date().toISOString();
    const threadIdForFork = options.threadId ?? createThreadId();
    const forked = normalizeSessionRecord({
      ...source,
      threadId: threadIdForFork,
      createdAt: now,
      updatedAt: now,
      metadata: {
        ...(source.metadata ?? {}),
        forkedFromId: source.threadId,
        forkedAt: now
      }
    }, {
      threadId: threadIdForFork,
      workingDirectory: options.workingDirectory ?? source.workingDirectory
    });

    await this.save(forked, {
      archived: false
    });

    return attachSessionStoreMetadata(forked, {
      filePath: this.sessionPath(threadIdForFork),
      archived: false
    });
  }

  async rollback(threadId, options = {}) {
    const session = await this.load(threadId, {
      includeArchived: true
    });

    if (!session) {
      return null;
    }

    const rolledBack = rollbackSessionTurns(session, {
      dropLastTurns: options.dropLastTurns ?? options.turns ?? 1
    });
    const archived = Boolean(session.archived);

    await this.save(rolledBack, {
      archived
    });

    return attachSessionStoreMetadata(rolledBack, {
      filePath: this.sessionPath(threadId, {
        archived
      }),
      archived
    });
  }

  async updateMetadata(threadId, metadataPatch = {}) {
    const session = await this.load(threadId, {
      includeArchived: true
    });

    if (!session) {
      return null;
    }

    const archived = Boolean(session.archived);
    const updated = normalizeSessionRecord({
      ...session,
      updatedAt: new Date().toISOString(),
      metadata: {
        ...(session.metadata ?? {}),
        ...metadataPatch
      }
    });

    await this.save(updated, {
      archived
    });

    return attachSessionStoreMetadata(updated, {
      filePath: this.sessionPath(threadId, {
        archived
      }),
      archived
    });
  }

  async replaceMetadata(threadId, metadata = {}) {
    const session = await this.load(threadId, {
      includeArchived: true
    });

    if (!session) {
      return null;
    }

    const archived = Boolean(session.archived);
    const updated = normalizeSessionRecord({
      ...session,
      updatedAt: new Date().toISOString(),
      metadata: {
        ...metadata
      }
    });

    await this.save(updated, {
      archived
    });

    return attachSessionStoreMetadata(updated, {
      filePath: this.sessionPath(threadId, {
        archived
      }),
      archived
    });
  }

  async injectResponseItems(threadId, items = [], options = {}) {
    const session = await this.load(threadId, {
      includeArchived: true
    });

    if (!session) {
      return null;
    }

    const archived = Boolean(session.archived);
    const updated = injectResponseItemsToSession(session, items, options);

    await this.save(updated, {
      archived
    });

    return attachSessionStoreMetadata(updated, {
      filePath: this.sessionPath(threadId, {
        archived
      }),
      archived
    });
  }

  async moveSession(threadId, options = {}) {
    const sourcePath = this.sessionPath(threadId, {
      archived: options.fromArchived
    });
    const targetPath = this.sessionPath(threadId, {
      archived: options.toArchived
    });

    await mkdir(dirname(targetPath), {
      recursive: true
    });
    await rm(targetPath, {
      force: true
    });

    try {
      await rename(sourcePath, targetPath);
    } catch (error) {
      if (error?.code !== "EXDEV") {
        throw error;
      }

      await copyFile(sourcePath, targetPath);
      await rm(sourcePath, {
        force: true
      });
    }

    const content = await readFile(targetPath, "utf8");
    return attachSessionStoreMetadata(normalizeSessionRecord(JSON.parse(content)), {
      filePath: targetPath,
      archived: Boolean(options.toArchived)
    });
  }

  sessionPath(threadId, options = {}) {
    return join(options.archived ? this.archivedRoot : this.root, `${sanitizeThreadId(threadId)}.json`);
  }
}

export function defaultSessionStoreDirectory() {
  return join(homedir(), ".codex-js", "sessions");
}

function sanitizeThreadId(threadId) {
  return String(threadId).replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function attachSessionStoreMetadata(session, options = {}) {
  return {
    ...session,
    path: options.filePath ?? session.path ?? null,
    archived: Boolean(options.archived ?? session.archived)
  };
}

function matchesSessionListFilters(session, options = {}) {
  if (options.cwd && resolve(String(session.workingDirectory ?? "")) !== resolve(String(options.cwd))) {
    return false;
  }

  if (options.searchTerm) {
    const needle = String(options.searchTerm).toLowerCase();
    const haystack = [
      session.threadId,
      session.workingDirectory,
      JSON.stringify(session.metadata ?? {}),
      ...(session.turns ?? []).map((turn) => turn.input),
      ...(session.history ?? []).map((entry) => entry.text)
    ].filter(Boolean).join("\n").toLowerCase();

    if (!haystack.includes(needle)) {
      return false;
    }
  }

  return true;
}

function compareSessionsNewestFirst(left, right) {
  return timestampValue(right.updatedAt ?? right.createdAt) - timestampValue(left.updatedAt ?? left.createdAt);
}

function timestampValue(value) {
  const time = Date.parse(value ?? "");

  return Number.isFinite(time) ? time : 0;
}

function clampLimit(limit) {
  const number = Number(limit);

  if (!Number.isFinite(number) || number <= 0) {
    return 50;
  }

  return Math.min(Math.floor(number), 200);
}

function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({
    offset
  })).toString("base64url");
}

function decodeCursor(cursor) {
  if (!cursor) {
    return 0;
  }

  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    const offset = Number(parsed.offset);

    return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  } catch {
    return 0;
  }
}
