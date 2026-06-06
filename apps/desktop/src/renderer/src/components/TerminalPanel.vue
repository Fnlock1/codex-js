<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { Plus, RotateCcw, Terminal as TerminalIcon, X } from "lucide-vue-next";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { BottomPanelTab, DiagnosticProblem, TerminalLine } from "../types";

interface TerminalSize {
  cols: number;
  rows: number;
}

interface PanelTab {
  id: BottomPanelTab;
  label: string;
}

defineProps<{
  activeTab: BottomPanelTab;
  connected: boolean;
  outputLines: TerminalLine[];
  problems: DiagnosticProblem[];
  shellLabel: string;
}>();

const emit = defineEmits<{
  "update:activeTab": [tab: BottomPanelTab];
  ready: [size: TerminalSize];
  input: [data: string];
  resize: [size: TerminalSize];
  clear: [];
  "new-terminal": [];
  "open-problem": [problem: DiagnosticProblem];
  close: [];
}>();

const terminalHost = ref<HTMLDivElement | null>(null);
const terminalTabs: PanelTab[] = [
  { id: "problems", label: "Problems" },
  { id: "output", label: "Output" },
  { id: "terminal", label: "Terminal" }
];
let xterm: Terminal | undefined;
let fitAddon: FitAddon | undefined;
let resizeObserver: ResizeObserver | undefined;

onMounted(async () => {
  await nextTick();
  createXterm();
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  xterm?.dispose();
  resizeObserver = undefined;
  xterm = undefined;
  fitAddon = undefined;
});

function createXterm(): void {
  if (!terminalHost.value) {
    return;
  }

  xterm = new Terminal({
    allowTransparency: true,
    convertEol: false,
    cursorBlink: true,
    cursorStyle: "block",
    disableStdin: false,
    fontFamily: 'Consolas, "Cascadia Code", "Courier New", monospace',
    fontSize: 14,
    lineHeight: 1.2,
    scrollback: 10_000,
    theme: {
      background: "#171917",
      foreground: "#e5e8e5",
      cursor: "#d8ddd8",
      selectionBackground: "#31513a",
      black: "#171917",
      red: "#ffb4ae",
      green: "#8fd08f",
      yellow: "#d7ba7d",
      blue: "#8db3e2",
      magenta: "#d2a8ff",
      cyan: "#79c0ff",
      white: "#d4d4d4",
      brightBlack: "#6e7681",
      brightRed: "#ffa198",
      brightGreen: "#a7f3a7",
      brightYellow: "#f2cb57",
      brightBlue: "#a5d6ff",
      brightMagenta: "#d2a8ff",
      brightCyan: "#b6e3ff",
      brightWhite: "#ffffff"
    }
  });
  fitAddon = new FitAddon();

  xterm.loadAddon(fitAddon);
  xterm.open(terminalHost.value);
  xterm.onData((data) => emit("input", data));
  xterm.onResize((size) => emit("resize", size));
  fitTerminal();
  emit("ready", getSize());
  xterm.focus();

  resizeObserver = new ResizeObserver(() => {
    fitTerminal();
  });
  resizeObserver.observe(terminalHost.value);
}

function fitTerminal(): void {
  if (!xterm || !fitAddon || !terminalHost.value || terminalHost.value.offsetParent === null) {
    return;
  }

  fitAddon.fit();
  emit("resize", getSize());
}

async function focusInput(): Promise<void> {
  await nextTick();
  fitTerminal();
  xterm?.focus();
}

function writeData(data: string): void {
  xterm?.write(data);
}

function clearXterm(): void {
  xterm?.clear();
  emit("clear");
}

function resetTerminal(): void {
  xterm?.reset();
  fitTerminal();
}

function getSize(): TerminalSize {
  return {
    cols: xterm?.cols ?? 80,
    rows: xterm?.rows ?? 24
  };
}

defineExpose({
  clearXterm,
  fitTerminal,
  focusInput,
  getSize,
  resetTerminal,
  writeData
});
</script>

<template>
  <section class="terminal-panel">
    <div class="panel-tabs">
      <button
        v-for="tab in terminalTabs"
        :key="tab.id"
        class="panel-tab"
        :class="{ active: activeTab === tab.id }"
        type="button"
        @click="$emit('update:activeTab', tab.id)"
      >
        {{ tab.label }}
      </button>
      <button class="icon-button compact" type="button" title="New terminal" @click="$emit('new-terminal')">
        <Plus :size="15" />
      </button>
      <span class="terminal-title">
        <TerminalIcon :size="15" />
        {{ shellLabel }}
      </span>
      <span class="terminal-status" :class="{ connected }">
        {{ connected ? "PTY connected" : "Starting PTY..." }}
      </span>
      <button class="icon-button compact" type="button" title="Clear" @click="clearXterm">
        <RotateCcw :size="14" />
      </button>
      <button class="icon-button compact" type="button" title="Close" @click="$emit('close')">
        <X :size="15" />
      </button>
    </div>

    <div v-show="activeTab === 'problems'" class="terminal-body problems-body">
      <button
        v-for="problem in problems"
        :key="problem.id"
        class="problem-row"
        type="button"
        @click="$emit('open-problem', problem)"
      >
        <span class="problem-severity" :class="problem.severity" />
        <span class="problem-location">{{ problem.path }}:{{ problem.line }}:{{ problem.column }}</span>
        <span class="problem-message">{{ problem.message }}</span>
        <span v-if="problem.source" class="problem-source">{{ problem.source }}</span>
      </button>
      <div v-if="problems.length === 0" class="empty-note success">
        No language service problems right now.
      </div>
    </div>

    <div v-show="activeTab === 'output'" class="terminal-body output-body">
      <div class="output-log-list">
        <div
          v-for="line in outputLines"
          :key="line.id"
          class="output-log-line"
          :class="line.tone"
        >
          {{ line.text }}
        </div>
        <div v-if="outputLines.length === 0" class="empty-note">
          No output yet.
        </div>
      </div>
    </div>

    <div v-show="activeTab === 'terminal'" class="terminal-body xterm-body">
      <div ref="terminalHost" class="xterm-host" />
    </div>
  </section>
</template>
