<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { Search } from "lucide-vue-next";
import type { ProjectIndexSymbol } from "@qoder-open/shared";
import type { PaletteCommand } from "../types";

const props = defineProps<{
  visible: boolean;
  commands: PaletteCommand[];
  symbols: ProjectIndexSymbol[];
}>();

const emit = defineEmits<{
  close: [];
  run: [id: string];
  "open-symbol": [symbol: ProjectIndexSymbol];
  "search-symbols": [query: string];
}>();

const query = ref("");
const inputRef = ref<HTMLInputElement | null>(null);

const filteredCommands = computed(() => {
  const needle = query.value.trim().toLowerCase();

  if (!needle) {
    return props.commands;
  }

  return props.commands.filter((command) =>
    `${command.title} ${command.detail}`.toLowerCase().includes(needle)
  );
});

watch(
  () => props.visible,
  async (visible) => {
    if (!visible) {
      query.value = "";
      return;
    }

    await nextTick();
    inputRef.value?.focus();
    inputRef.value?.select();
  }
);

watch(query, (value) => {
  emit("search-symbols", value);
});

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
    return;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    const command = filteredCommands.value[0];
    const symbol = props.symbols[0];

    if (command) {
      emit("run", command.id);
      return;
    }

    if (symbol) {
      emit("open-symbol", symbol);
    }
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="command-palette-backdrop" @mousedown.self="$emit('close')">
      <section class="command-palette" @keydown="handleKeydown">
        <div class="palette-input-row">
          <Search :size="18" />
          <input
            ref="inputRef"
            v-model="query"
            class="palette-input"
            type="text"
            placeholder="运行命令或搜索符号..."
          />
        </div>

        <div class="palette-results">
          <button
            v-for="command in filteredCommands"
            :key="command.id"
            class="palette-row"
            type="button"
            @click="$emit('run', command.id)"
          >
            <span class="palette-title">{{ command.title }}</span>
            <span class="palette-detail">{{ command.detail }}</span>
            <span v-if="command.shortcut" class="palette-shortcut">{{ command.shortcut }}</span>
          </button>

          <div v-if="symbols.length > 0" class="palette-section-title">Project Symbols</div>
          <button
            v-for="symbol in symbols"
            :key="`${symbol.path}:${symbol.line}:${symbol.name}`"
            class="palette-row symbol"
            type="button"
            @click="$emit('open-symbol', symbol)"
          >
            <span class="palette-title">{{ symbol.name }}</span>
            <span class="palette-detail">
              {{ symbol.kind }} - {{ symbol.path }}:{{ symbol.line }}
            </span>
          </button>

          <div v-if="filteredCommands.length === 0 && symbols.length === 0" class="palette-empty">
            没有匹配命令或符号。
          </div>
        </div>
      </section>
    </div>
  </Teleport>
</template>
