/** 运维写操作仅由显式部署调用；禁止在常规测试中调用真实接口。 */
export async function notifyDeployment(token: string | undefined, baseUrl = "http://127.0.0.1:4850"): Promise<void> {
  if (!token?.trim()) throw new Error("生产容器未配置 MAINTENANCE_TOKEN，禁止无通知重启");
  if (/[\r\n]/.test(token)) throw new Error("MAINTENANCE_TOKEN 格式无效，禁止重启");
  const response = await fetch(`${baseUrl}/api/system/notify-shutdown`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token.trim()}` },
    signal: AbortSignal.timeout(3_000),
  }).catch(() => { throw new Error("维护通知请求失败或超时，禁止重启"); });
  if (!response.ok) throw new Error(`维护通知被拒绝 (${response.status})，禁止重启`);
}

if (import.meta.main) {
  await notifyDeployment(Bun.env.MAINTENANCE_TOKEN);
  console.log("维护通知已获授权并成功发送");
}
