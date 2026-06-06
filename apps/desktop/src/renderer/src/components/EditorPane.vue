<script setup lang="ts">
import { Plus, RotateCcw, Save, X } from "lucide-vue-next";
import MonacoEditor from "./MonacoEditor.vue";
import type { OpenTab } from "../types";
import { badgeForPath } from "../utils/tree";

const props = defineProps<{
  openTabs: OpenTab[];
  selectedFile: string;
  breadcrumbItems: string[];
  content: string;
  isDirty: boolean;
  saveBusy: boolean;
  canEdit: boolean;
}>();

defineEmits<{
  "open-file": [path: string];
  "close-tab": [path: string];
  "update-content": [content: string];
  "save-file": [];
  "discard-changes": [];
  "new-file": [];
}>();

</script>

<template>
  <section class="editor-workspace">
    <div class="editor-tabs">
      <button
        v-for="tab in openTabs"
        :key="tab.path"
        class="editor-tab"
        :class="{ active: selectedFile === tab.path, dirty: tab.isDirty }"
        type="button"
        @click="$emit('open-file', tab.path)"
      >
        <span class="tab-badge">{{ badgeForPath(tab.path) || "TXT" }}</span>
        <span>{{ tab.label }}</span>
        <span v-if="tab.isDirty" class="dirty-dot" title="Unsaved changes" />
        <X class="tab-close" :size="14" @click.stop="$emit('close-tab', tab.path)" />
      </button>
      <button class="icon-button add-tab" type="button" title="New file" @click="$emit('new-file')">
        <Plus :size="17" />
      </button>
    </div>

    <div class="breadcrumbs">
      <div class="breadcrumb-path">
        <span
          v-for="(item, index) in breadcrumbItems"
          :key="`${item}-${index}`"
          class="breadcrumb-item"
        >
          {{ item }}
        </span>
      </div>
      <div class="editor-actions">
        <button
          class="icon-button compact"
          type="button"
          title="Save file"
          :disabled="!isDirty || saveBusy || !canEdit"
          @click="$emit('save-file')"
        >
          <Save :size="15" />
        </button>
        <button
          class="icon-button compact"
          type="button"
          title="Discard changes"
          :disabled="!isDirty || saveBusy || !canEdit"
          @click="$emit('discard-changes')"
        >
          <RotateCcw :size="15" />
        </button>
      </div>
    </div>

    <section class="editor-pane" :class="{ readonly: !canEdit }">
      <MonacoEditor
        :path="selectedFile || 'preview.ts'"
        :content="content"
        :read-only="!canEdit"
        @update-content="$emit('update-content', $event)"
        @save-file="$emit('save-file')"
      />
    </section>
  </section>
</template>
