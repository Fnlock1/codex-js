<script setup lang="ts">
import { Bug, Files, GitBranch, Search, Square } from "lucide-vue-next";
import type { ActivityId } from "../types";

defineProps<{
  activeActivity: ActivityId;
}>();

defineEmits<{
  select: [activity: ActivityId];
}>();

const activityItems = [
  { id: "files" as const, label: "资源管理器", icon: Files },
  { id: "search" as const, label: "搜索", icon: Search },
  { id: "source" as const, label: "源代码管理", icon: GitBranch },
  { id: "run" as const, label: "运行和终端", icon: Bug },
  { id: "extensions" as const, label: "扩展与服务", icon: Square }
];
</script>

<template>
  <aside class="activitybar">
    <button
      v-for="item in activityItems"
      :key="item.id"
      class="activity-button"
      :class="{ active: activeActivity === item.id }"
      type="button"
      :title="item.label"
      @click="$emit('select', item.id)"
    >
      <component :is="item.icon" :size="22" />
    </button>
  </aside>
</template>
