// 字体子集化的工作线程：subset-font 把 harfbuzz 的 WASM 实例化在调用线程里同步执行，
// 在主线程里排队只是串行；放进线程池才真正并行。
// 每个线程只保留当前正在用的那份源字体，任务按源文件连续派发，避免同时驻留多份 26MB 的 TTF。
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import subsetFont from "subset-font";

const { sourceDir } = workerData;
let currentFile = null;
let currentBuffer = null;

parentPort.on("message", async ({ id, file, text }) => {
  try {
    if (file !== currentFile) {
      currentBuffer = await readFile(path.join(sourceDir, file));
      currentFile = file;
    }
    const data = await subsetFont(currentBuffer, text, { targetFormat: "woff2" });
    parentPort.postMessage({ id, data: new Uint8Array(data) });
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
