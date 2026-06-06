import { computed, ref, type Ref } from "vue";
import type { BottomPanelTab, TerminalLine } from "../types";

export function useTerminal(workspacePath: Ref<string>) {
  const activeTerminalTab = ref<BottomPanelTab>("terminal");
  const terminalCommand = ref("");
  const terminalCwd = ref("");
  const terminalSessionId = ref("");
  const terminalVisible = ref(true);
  const terminalBusy = ref(false);
  const terminalLines = ref<TerminalLine[]>([
    {
      id: createId(),
      text: "Qoder output channel initialized.",
      tone: "muted"
    }
  ]);

  const terminalPrompt = computed(() => `PS ${terminalCwd.value || workspacePath.value || "workspace"}>`);

  function pushTerminalLine(text: string, tone: TerminalLine["tone"] = "muted"): void {
    terminalLines.value.push({
      id: createId(),
      text,
      tone
    });
  }

  function clearTerminal(): void {
    terminalLines.value = [
      {
        id: createId(),
        text: "Output channel cleared.",
        tone: "muted"
      }
    ];
  }

  function showTerminal(): void {
    terminalVisible.value = true;
    activeTerminalTab.value = "terminal";
  }

  function setTerminalCwd(cwd: string): void {
    terminalCwd.value = cwd;
  }

  function setTerminalSessionId(sessionId: string): void {
    terminalSessionId.value = sessionId;
  }

  function clearTerminalSession(): void {
    terminalSessionId.value = "";
  }

  function hideTerminal(): void {
    terminalVisible.value = false;
  }

  function newTerminal(): void {
    terminalCommand.value = "";
    terminalCwd.value = workspacePath.value;
    terminalSessionId.value = "";
    activeTerminalTab.value = "terminal";
    terminalVisible.value = true;
    terminalLines.value = [
      {
        id: createId(),
        text: "Qoder output channel initialized.",
        tone: "muted"
      }
    ];
  }

  async function runTerminalCommand(
    command: string,
    runner: (command: string) => Promise<void>
  ): Promise<void> {
    const trimmed = command.trim();

    if (!trimmed || terminalBusy.value) {
      return;
    }

    terminalVisible.value = true;
    activeTerminalTab.value = "terminal";
    terminalBusy.value = true;

    try {
      await runner(trimmed);
      terminalCommand.value = "";
    } finally {
      terminalBusy.value = false;
    }
  }

  return {
    activeTerminalTab,
    terminalCommand,
    terminalCwd,
    terminalSessionId,
    terminalVisible,
    terminalBusy,
    terminalLines,
    terminalPrompt,
    pushTerminalLine,
    clearTerminal,
    showTerminal,
    setTerminalCwd,
    setTerminalSessionId,
    clearTerminalSession,
    hideTerminal,
    newTerminal,
    runTerminalCommand
  };
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}
