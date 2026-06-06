<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Maximize2,
  Minus,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Search,
  X
} from "lucide-vue-next";

type TopMenuId = "file" | "edit" | "selection" | "view" | "go" | "run" | "terminal" | "help";
type FileMenuAction =
  | "new-text-file"
  | "new-file"
  | "open-file"
  | "open-folder"
  | "save"
  | "save-as"
  | "save-all"
  | "close-file"
  | "revert-file";
type TerminalMenuAction = "new-terminal" | "show-terminal" | "clear-terminal" | "close-terminal";
type MenuAction = FileMenuAction | TerminalMenuAction;

interface TopMenu {
  id: TopMenuId;
  label: string;
}

interface MenuEntry {
  type?: "item" | "separator";
  label?: string;
  shortcut?: string;
  action?: MenuAction;
  disabled?: boolean;
}

const props = defineProps<{
  projectName: string;
  hasCurrentFile: boolean;
  hasDirtyTabs: boolean;
  saveBusy: boolean;
  terminalVisible: boolean;
}>();

const emit = defineEmits<{
  "open-folder": [];
  "file-action": [action: FileMenuAction];
  "terminal-action": [action: TerminalMenuAction];
  minimize: [];
  maximize: [];
  close: [];
}>();

const shellRef = ref<HTMLElement | null>(null);
const activeMenu = ref<TopMenuId | null>(null);
const menuItems: TopMenu[] = [
  { id: "file", label: "文件" },
  { id: "edit", label: "编辑" },
  { id: "selection", label: "选择" },
  { id: "view", label: "查看" },
  { id: "go", label: "转到" },
  { id: "run", label: "运行" },
  { id: "terminal", label: "终端" },
  { id: "help", label: "帮助" }
];

onMounted(() => {
  document.addEventListener("pointerdown", handlePointerDown);
  document.addEventListener("keydown", handleDocumentKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", handlePointerDown);
  document.removeEventListener("keydown", handleDocumentKeydown);
});

function menuEntries(menuId: TopMenuId): MenuEntry[] {
  if (menuId === "file") {
    return [
      { label: "新建文本文件", shortcut: "Ctrl+N", action: "new-text-file" },
      { label: "新建文件...", shortcut: "Ctrl+Alt+N", action: "new-file" },
      { label: "新建窗口", shortcut: "Ctrl+Shift+N", disabled: true },
      { label: "使用配置文件新建窗口", disabled: true },
      { type: "separator" },
      { label: "打开文件...", shortcut: "Ctrl+O", action: "open-file" },
      { label: "打开文件夹...", shortcut: "Ctrl+K Ctrl+O", action: "open-folder" },
      { label: "从文件打开工作区...", disabled: true },
      { label: "打开最近的文件", disabled: true },
      { type: "separator" },
      { label: "将文件夹添加到工作区...", disabled: true },
      { label: "将工作区另存为...", disabled: true },
      { label: "复制工作区", disabled: true },
      { type: "separator" },
      { label: "保存", shortcut: "Ctrl+S", action: "save", disabled: !props.hasCurrentFile || !props.hasDirtyTabs || props.saveBusy },
      { label: "另存为...", shortcut: "Ctrl+Shift+S", action: "save-as", disabled: !props.hasCurrentFile || props.saveBusy },
      { label: "全部保存", shortcut: "Ctrl+K S", action: "save-all", disabled: !props.hasDirtyTabs || props.saveBusy },
      { type: "separator" },
      { label: "关闭文件", shortcut: "Ctrl+F4", action: "close-file", disabled: !props.hasCurrentFile },
      { label: "还原文件", action: "revert-file", disabled: !props.hasCurrentFile || !props.hasDirtyTabs || props.saveBusy },
      { type: "separator" },
      { label: "共享", disabled: true },
      { label: "自动保存", disabled: true },
      { label: "首选项", disabled: true }
    ];
  }

  if (menuId === "terminal") {
    return [
      { label: "新建终端", shortcut: "Ctrl+`", action: "new-terminal" },
      { label: props.terminalVisible ? "聚焦终端" : "显示终端", action: "show-terminal" },
      { label: "清空终端", action: "clear-terminal" },
      { type: "separator" },
      { label: "关闭终端", action: "close-terminal", disabled: !props.terminalVisible }
    ];
  }

  return [];
}

function toggleMenu(menuId: TopMenuId): void {
  if (menuId !== "file" && menuId !== "terminal") {
    activeMenu.value = null;
    return;
  }

  activeMenu.value = activeMenu.value === menuId ? null : menuId;
}

function runMenuAction(entry: MenuEntry): void {
  if (!entry.action || entry.disabled) {
    return;
  }

  activeMenu.value = null;

  if (entry.action === "open-folder") {
    emit("open-folder");
    return;
  }

  if (isTerminalAction(entry.action)) {
    emit("terminal-action", entry.action);
    return;
  }

  emit("file-action", entry.action);
}

function handlePointerDown(event: PointerEvent): void {
  if (!shellRef.value?.contains(event.target as Node)) {
    activeMenu.value = null;
  }
}

function handleDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    activeMenu.value = null;
  }
}

function isTerminalAction(action: MenuAction): action is TerminalMenuAction {
  return action.endsWith("terminal");
}
</script>

<template>
  <header ref="shellRef" class="titlebar">
    <nav class="menu-strip">
      <div
        v-for="item in menuItems"
        :key="item.id"
        class="menu-wrapper"
      >
        <button
          class="menu-item"
          :class="{ active: activeMenu === item.id }"
          type="button"
          @click="toggleMenu(item.id)"
        >
          {{ item.label }}
        </button>

        <div
          v-if="activeMenu === item.id"
          class="menu-dropdown"
          role="menu"
        >
          <template
            v-for="(entry, index) in menuEntries(item.id)"
            :key="`${entry.label ?? 'separator'}-${index}`"
          >
            <div v-if="entry.type === 'separator'" class="menu-separator" />
            <button
              v-else
              class="menu-command"
              :class="{ disabled: entry.disabled }"
              type="button"
              role="menuitem"
              :disabled="entry.disabled"
              @click="runMenuAction(entry)"
            >
              <span class="menu-command-label">{{ entry.label }}</span>
              <span v-if="entry.shortcut" class="menu-shortcut">{{ entry.shortcut }}</span>
            </button>
          </template>
        </div>
      </div>
    </nav>

    <div class="title-center">
      <span class="project-name">{{ projectName }}</span>
      <button class="icon-button subtle" type="button" title="后退">
        <ArrowLeft :size="16" />
      </button>
      <button class="icon-button subtle" type="button" title="前进">
        <ArrowRight :size="16" />
      </button>
    </div>

    <div class="title-actions">
      <button class="primary-title-button" type="button" @click="$emit('open-folder')">
        打开工作区
        <ExternalLink :size="15" />
      </button>
      <button class="icon-button subtle" type="button" title="搜索">
        <Search :size="17" />
      </button>
      <button class="icon-button subtle" type="button" title="左侧栏">
        <PanelLeft :size="17" />
      </button>
      <button class="icon-button subtle" type="button" title="底部面板">
        <PanelBottom :size="17" />
      </button>
      <button class="icon-button subtle" type="button" title="右侧栏">
        <PanelRight :size="17" />
      </button>
      <button class="window-button" type="button" title="最小化" @click="$emit('minimize')">
        <Minus :size="16" />
      </button>
      <button class="window-button" type="button" title="最大化" @click="$emit('maximize')">
        <Maximize2 :size="14" />
      </button>
      <button class="window-button close" type="button" title="关闭" @click="$emit('close')">
        <X :size="16" />
      </button>
    </div>
  </header>
</template>
