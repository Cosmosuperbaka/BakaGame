import { availablePort, startIsolatedServer } from "./IsolatedServer";
import { probeDeployment } from "./DeploymentProbe";

const server = await startIsolatedServer(await availablePort());
const abort = new AbortController();
try {
  await server.ready();
  await server.run(probeDeployment(server.baseUrl, 15_000, abort.signal));
  console.log("隔离生产服务冒烟通过: 自有进程、业务就绪与三个订阅 ACK");
} finally {
  abort.abort();
  await server.stop();
}
