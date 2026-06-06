<script setup lang="ts">
import { computed, ref } from "vue";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileCode2,
  Folder,
  FolderOpen,
  MoreHorizontal,
  Play,
  RefreshCcw,
  Search,
  Trash2
} from "lucide-vue-next";
import type { GitStatusFile, LanguageServerStatus } from "@qoder-open/shared";
import type { ActivityId, GitBranchInfo, GitDiff, GitStatus, SearchMatch, TreeRow } from "../types";
import { badgeForPath } from "../utils/tree";

const props = defineProps<{
  activeActivity: ActivityId;
  workspaceLabel: string;
  loadError: string;
  rows: TreeRow[];
  expandedPaths: Set<string>;
  selectedFile: string;
  searchResults: SearchMatch[];
  gitStatus: GitStatus | null;
  gitDiff: GitDiff | null;
  gitBranches: GitBranchInfo[];
  selectedGitFile: string;
  gitBusy: boolean;
  commandBusy: boolean;
  languageServers: LanguageServerStatus[];
}>();

const emit = defineEmits<{
  "open-folder": [];
  "select-row": [row: TreeRow];
  search: [payload: { query: string; glob?: string }];
  "open-search": [match: SearchMatch];
  "refresh-git": [];
  "open-git-diff": [path: string];
  "stage-git-file": [path: string];
  "stage-all-git-files": [];
  "unstage-git-file": [path: string];
  "discard-git-file": [path: string];
  "commit-git-changes": [message: string];
  "refresh-language-servers": [];
  "run-command": [command: string];
}>();

const searchQuery = ref("");
const searchGlob = ref("*.{ts,tsx,js,jsx,vue,md,json,css}");
const command = ref("pnpm check");
const commitMessage = ref("");

const title = computed(() => {
  const map: Record<ActivityId, string> = {
    files: "Explorer",
    search: "Search",
    source: "Source Control",
    run: "Run and Terminal",
    extensions: "Extensions and Services"
  };

  return map[props.activeActivity];
});

function runSearch(): void {
  emit("search", {
    query: searchQuery.value,
    glob: searchGlob.value
  });
}

function runCommand(): void {
  emit("run-command", command.value);
}

function commitChanges(): void {
  const message = commitMessage.value.trim();

  if (!message) {
    return;
  }

  emit("commit-git-changes", message);
  commitMessage.value = "";
}

function statusLabel(index: string, workingTree: string): string {
  const code = `${index}${workingTree}`.trim();

  if (code === "??") {
    return "U";
  }

  return code || "M";
}

function hasStagedChange(file: GitStatusFile): boolean {
  return Boolean(file.index.trim()) && file.index !== "?";
}

function hasWorktreeChange(file: GitStatusFile): boolean {
  return Boolean(file.workingTree.trim()) || file.index === "?";
}

function diffLines(diff: string): string[] {
  return diff.split(/\r?\n/).filter(Boolean).slice(0, 260);
}

function diffLineClass(line: string): Record<string, boolean> {
  return {
    addition: line.startsWith("+") && !line.startsWith("+++"),
    deletion: line.startsWith("-") && !line.startsWith("---"),
    hunk: line.startsWith("@@"),
    meta: line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")
  };
}

function languageServiceText(server: LanguageServerStatus): string {
  const capabilities = server.capabilities
    ? [
        server.capabilities.diagnostics ? "diagnostics" : "",
        server.capabilities.completion ? "completion" : "",
        server.capabilities.hover ? "hover" : "",
        server.capabilities.definition ? "definition" : "",
        server.capabilities.references ? "references" : "",
        server.capabilities.codeAction ? "quick fix" : "",
        server.capabilities.rename ? "rename" : "",
        server.capabilities.formatting ? "format" : ""
      ].filter(Boolean)
    : [];

  if (server.state === "ready" && capabilities.length > 0) {
    return `Ready: ${capabilities.join(" / ")}`;
  }

  if (server.state === "starting") {
    return server.detail ?? "Starting and indexing workspace...";
  }

  if (server.state === "crashed") {
    return server.detail ?? "Language server crashed.";
  }

  if (server.state === "missing") {
    return server.detail ?? "Language server executable was not found.";
  }

  return server.detail ?? (server.available ? "Installed, starts when a matching file opens." : "");
}

function languageServiceDotClass(server: LanguageServerStatus): Record<string, boolean> {
  return {
    active: server.state === "ready",
    starting: server.state === "starting",
    crashed: server.state === "crashed",
    missing: server.state === "missing"
  };
}
</script>

<template>
  <aside class="sidebar">
    <section class="sidebar-section">
      <div class="sidebar-title-row">
        <span>{{ title }}</span>
        <button class="icon-button compact" type="button" title="More">
          <MoreHorizontal :size="16" />
        </button>
      </div>

      <template v-if="activeActivity === 'files'">
        <button class="workspace-root" type="button" @click="$emit('open-folder')">
          <ChevronDown :size="15" />
          <span>{{ workspaceLabel }}</span>
        </button>

        <div v-if="loadError" class="load-error">{{ loadError }}</div>

        <div class="tree-list">
          <button
            v-for="row in rows"
            :key="row.path"
            class="tree-row"
            :class="{ selected: selectedFile === row.path }"
            :style="{ '--level': row.level }"
            type="button"
            @click="$emit('select-row', row)"
          >
            <span class="tree-indent" />
            <ChevronRight
              v-if="row.kind === 'directory' && !expandedPaths.has(row.path)"
              class="tree-chevron"
              :size="14"
            />
            <ChevronDown
              v-else-if="row.kind === 'directory'"
              class="tree-chevron"
              :size="14"
            />
            <span v-else class="tree-chevron" />
            <FolderOpen
              v-if="row.kind === 'directory' && expandedPaths.has(row.path)"
              class="tree-folder"
              :size="16"
            />
            <Folder
              v-else-if="row.kind === 'directory'"
              class="tree-folder"
              :size="16"
            />
            <span v-else-if="badgeForPath(row.path)" class="file-badge">{{ badgeForPath(row.path) }}</span>
            <FileCode2 v-else class="tree-file" :size="15" />
            <span class="tree-label">{{ row.name }}</span>
          </button>
        </div>
      </template>

      <template v-else-if="activeActivity === 'search'">
        <div class="tool-form">
          <label class="field-label" for="search-query">Search text</label>
          <input
            id="search-query"
            v-model="searchQuery"
            class="tool-input"
            type="text"
            placeholder="TODO, function name, error message"
            @keydown.enter="runSearch"
          />
          <label class="field-label" for="search-glob">File glob</label>
          <input
            id="search-glob"
            v-model="searchGlob"
            class="tool-input"
            type="text"
            placeholder="*.{ts,vue}"
            @keydown.enter="runSearch"
          />
          <button class="tool-primary" type="button" @click="runSearch">
            <Search :size="15" />
            Search
          </button>
        </div>

        <div class="result-list">
          <button
            v-for="match in searchResults"
            :key="`${match.path}:${match.line}:${match.text}`"
            class="result-row"
            type="button"
            @click="$emit('open-search', match)"
          >
            <span class="result-path">{{ match.path }}:{{ match.line }}</span>
            <span class="result-text">{{ match.text }}</span>
          </button>
          <div v-if="searchResults.length === 0" class="empty-note">
            Enter a keyword to search the current workspace.
          </div>
        </div>
      </template>

      <template v-else-if="activeActivity === 'source'">
        <div class="source-header">
          <div>
            <div class="source-branch">{{ gitStatus?.branch ?? "No branch" }}</div>
            <div class="source-subtitle">
              {{ gitStatus?.clean ? "Working tree clean" : `${gitStatus?.files.length ?? 0} changed file(s)` }}
            </div>
          </div>
          <div class="source-header-actions">
            <button
              class="icon-button compact"
              type="button"
              title="Stage all"
              :disabled="gitBusy || gitStatus?.clean"
              @click="$emit('stage-all-git-files')"
            >
              +
            </button>
            <button
              class="icon-button compact"
              type="button"
              title="Refresh"
              :disabled="gitBusy"
              @click="$emit('refresh-git')"
            >
              <RefreshCcw :size="15" />
            </button>
          </div>
        </div>

        <div class="git-commit-box">
          <textarea
            v-model="commitMessage"
            class="git-commit-input"
            rows="3"
            placeholder="Commit message"
            :disabled="gitBusy"
            @keydown.ctrl.enter.prevent="commitChanges"
            @keydown.meta.enter.prevent="commitChanges"
          />
          <button
            class="tool-primary"
            type="button"
            :disabled="gitBusy || !commitMessage.trim()"
            @click="commitChanges"
          >
            Commit
          </button>
        </div>

        <div v-if="gitBranches.length > 0" class="git-branches">
          <span
            v-for="branch in gitBranches.slice(0, 5)"
            :key="branch.name"
            class="git-branch-pill"
            :class="{ current: branch.current }"
          >
            {{ branch.current ? "current" : "branch" }}: {{ branch.name }}
          </span>
        </div>

        <div class="result-list git-file-list">
          <div
            v-for="file in gitStatus?.files ?? []"
            :key="`${file.index}${file.workingTree}${file.path}`"
            class="git-change-row"
            :class="{ selected: selectedGitFile === file.path }"
          >
            <button
              class="git-file-main"
              type="button"
              @click="$emit('open-git-diff', file.path)"
              @dblclick="$emit('open-search', { path: file.path, line: 1, text: '' })"
            >
              <span class="git-status">{{ statusLabel(file.index, file.workingTree) }}</span>
              <span class="result-path">{{ file.path }}</span>
            </button>
            <div class="git-row-actions">
              <button
                v-if="hasWorktreeChange(file)"
                class="git-action"
                type="button"
                title="Stage"
                :disabled="gitBusy"
                @click="$emit('stage-git-file', file.path)"
              >
                +
              </button>
              <button
                v-if="hasStagedChange(file)"
                class="git-action"
                type="button"
                title="Unstage"
                :disabled="gitBusy"
                @click="$emit('unstage-git-file', file.path)"
              >
                -
              </button>
              <button
                class="git-action danger"
                type="button"
                title="Discard"
                :disabled="gitBusy"
                @click="$emit('discard-git-file', file.path)"
              >
                <Trash2 :size="13" />
              </button>
            </div>
          </div>
          <div v-if="gitStatus?.clean" class="empty-note success">
            <CheckCircle2 :size="15" />
            No pending Git changes.
          </div>
        </div>

        <div class="git-diff-panel">
          <div class="git-diff-title">
            <span>{{ gitDiff?.path ?? "Select a file to preview diff" }}</span>
            <span v-if="gitBusy">Working...</span>
          </div>

          <template v-if="gitDiff">
            <div v-if="gitDiff.staged" class="git-diff-section">
              <div class="git-diff-section-title">Staged</div>
              <pre class="git-diff-code"><span
                v-for="(line, index) in diffLines(gitDiff.staged)"
                :key="`staged-${index}`"
                :class="diffLineClass(line)"
              >{{ line }}
</span></pre>
            </div>
            <div v-if="gitDiff.unstaged" class="git-diff-section">
              <div class="git-diff-section-title">Changes</div>
              <pre class="git-diff-code"><span
                v-for="(line, index) in diffLines(gitDiff.unstaged)"
                :key="`unstaged-${index}`"
                :class="diffLineClass(line)"
              >{{ line }}
</span></pre>
            </div>
            <div v-if="!gitDiff.staged && !gitDiff.unstaged" class="empty-note">
              No textual diff for this file.
            </div>
          </template>
        </div>
      </template>

      <template v-else-if="activeActivity === 'run'">
        <div class="tool-form">
          <label class="field-label" for="command-input">Workspace command</label>
          <input
            id="command-input"
            v-model="command"
            class="tool-input"
            type="text"
            placeholder="pnpm check"
            @keydown.enter="runCommand"
          />
          <button class="tool-primary" type="button" :disabled="commandBusy" @click="runCommand">
            <Play :size="15" />
            {{ commandBusy ? "Running..." : "Run" }}
          </button>
          <p class="panel-note">
            Commands run in the current workspace. Output is shown in the bottom terminal panel.
          </p>
        </div>
      </template>

      <template v-else-if="activeActivity === 'extensions'">
        <div class="source-header">
          <div>
            <div class="source-branch">Language Services</div>
            <div class="source-subtitle">
              Vue / Python / Rust / Go completion providers
            </div>
          </div>
          <button
            class="icon-button compact"
            type="button"
            title="Refresh language services"
            @click="$emit('refresh-language-servers')"
          >
            <RefreshCcw :size="15" />
          </button>
        </div>

        <div class="service-list">
          <div
            v-for="server in languageServers"
            :key="server.languageId"
            class="service-row"
          >
            <span class="service-dot" :class="languageServiceDotClass(server)" />
            <div>
              <strong>{{ server.label }}</strong>
              <span>{{ languageServiceText(server) }}</span>
            </div>
          </div>
          <div class="service-row">
            <span class="service-dot active" />
            <div>
              <strong>Workspace Tools</strong>
              <span>Search, Git, terminal, file IO, and language features.</span>
            </div>
          </div>
        </div>
      </template>

    </section>

    <section class="sidebar-footer">
      <button class="fold-row" type="button">
        <ChevronRight :size="14" />
        <span>Outline</span>
      </button>
      <button class="fold-row" type="button">
        <ChevronRight :size="14" />
        <span>Timeline</span>
      </button>
    </section>
  </aside>
</template>
