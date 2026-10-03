const worker = new Worker(new URL("./DeniedWorker.ts", import.meta.url).href);
const result = await new Promise<string>((resolve, reject) => {
  worker.onmessage = event => resolve(String(event.data));
  worker.onerror = event => reject(new Error(event.message));
});
worker.terminate();
if (result !== "隔离测试禁止主动网络出口") throw new Error("Worker 出口未封闭");
console.log(result);
