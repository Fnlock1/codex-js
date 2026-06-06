<script setup lang="ts">
defineProps<{
  statusText: string;
  languageMode: string;
}>();
</script>

<template>
  <footer class="statusbar">
    <span>× 0</span>
    <span>△ 0</span>
    <span class="analysis-status">{{ statusText }}</span>
    <span class="status-spacer" />
    <span>行 1，列 1</span>
    <span>空格: 2</span>
    <span>UTF-8</span>
    <span>CRLF</span>
    <span>{{ languageMode }}</span>
    <span>NEXT</span>
  </footer>
</template>
