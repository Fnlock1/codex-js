#!/usr/bin/env node
/**
 * 中文模块说明：bin/codex-js.js
 *
 * CLI 可执行入口，负责把命令行调用转交给 src/cli.js。
 */
import { runCli } from "../src/cli.js";

runCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env
}).then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error) => {
  process.stderr.write(`${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
});
