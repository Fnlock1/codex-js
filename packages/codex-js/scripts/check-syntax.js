#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots = ["bin", "src"];
const files = roots
  .flatMap((root) => collectJavaScriptFiles(path.join(packageRoot, root)))
  .sort((left, right) => left.localeCompare(right));

let failed = false;

for (const filePath of files) {
  const relativePath = path.relative(packageRoot, filePath);
  const result = spawnSync(process.execPath, ["--check", filePath], {
    cwd: packageRoot,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    failed = true;
    process.stderr.write(`node --check failed: ${relativePath}\n`);

    if (result.stdout) {
      process.stderr.write(result.stdout);
    }

    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  process.stdout.write(`Checked ${files.length} JavaScript files.\n`);
}

function collectJavaScriptFiles(directory) {
  const entries = readdirSync(directory);
  const filesInDirectory = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry);
    const stats = statSync(entryPath);

    if (stats.isDirectory()) {
      filesInDirectory.push(...collectJavaScriptFiles(entryPath));
      continue;
    }

    if (stats.isFile() && entry.endsWith(".js")) {
      filesInDirectory.push(entryPath);
    }
  }

  return filesInDirectory;
}
