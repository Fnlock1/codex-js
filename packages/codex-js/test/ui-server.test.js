/**
 * 中文模块说明：test/ui-server.test.js
 *
 * 测试 codex-js 浏览器工作台服务和 SSE 事件桥接。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { startCodexJsUiServer } from "../src/ui/server.js";

test("UI server serves workbench HTML and streams exec events", async () => {
  const output = createWritableCapture();
  const { server, address } = await startCodexJsUiServer({
    port: 0,
    stdout: output
  });

  try {
    assert.match(output.text, /codex-js ui running/);

    const htmlResponse = await fetch(address);
    const html = await htmlResponse.text();
    assert.equal(htmlResponse.status, 200);
    assert.match(html, /codex-js 工作台/);

    const runResponse = await fetch(`${address}/api/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        prompt: "hello from ui test",
        modelProvider: "",
        model: "",
        modelTimeoutMs: "",
        maxToolIterations: ""
      })
    });
    const stream = await runResponse.text();

    assert.equal(runResponse.status, 200);
    assert.match(stream, /event: meta/);
    assert.match(stream, /event: codex-event/);
    assert.match(stream, /thread\.started/);
    assert.match(stream, /turn\.completed/);
    assert.match(stream, /event: done/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

/**
 * 创建测试用输出捕获器。
 *
 * @returns {{text: string, write(text: string): void}} 捕获器。
 */
function createWritableCapture() {
  return {
    text: "",
    write(text) {
      this.text += String(text);
    }
  };
}
