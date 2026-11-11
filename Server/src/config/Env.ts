import { readAccountGroupEnv, type EnvAccount } from "./env/Account";
import { readBootstrapEnv, type EnvBootstrap } from "./env/Bootstrap";
import { readClientChannelEnv, type EnvClientChannel } from "./env/ClientChannel";
import {
  readObservabilityEnv,
  resolveDeploymentEnvironment,
  resolveStatusFrontendUrl,
  type EnvObservability,
} from "./env/Observability";
import { readBangumiEnv, type EnvBangumi } from "./env/Bangumi";

export type { AccountEnv, NapCatEnv, SmtpEnv } from "./env/Account";

/**
 * 全部分组解析结果合成的启动配置。
 *
 * 读取与校验按域拆在 `config/env/` 下，本文件只做装配；每个环境变量的**分层归属**
 * （引导 / 进程拓扑 / 部署期可调 / 运行期热更）记在 `env/Registry.ts`，
 * `.env.example` 由它生成。判据见 `Agents/Conventions.md` §5。
 */
export interface AppEnv
  extends EnvBootstrap, EnvObservability, EnvAccount, EnvBangumi, EnvClientChannel {}

export const readEnv = (): AppEnv => {
  const bootstrap = readBootstrapEnv();
  const deploymentEnvironment = resolveDeploymentEnvironment();
  const observability = readObservabilityEnv(deploymentEnvironment);

  return {
    ...bootstrap,
    ...observability,
    // 前端探测地址跟着 CLIENT_URL 兜底：放在装配这一层解析，直接构造 env 的单测不会因此去探本机端口。
    statusFrontendUrl: resolveStatusFrontendUrl(
      observability.statusFrontendUrl,
      bootstrap.clientUrl
    ),
    ...readAccountGroupEnv(bootstrap.clientUrl),
    ...readBangumiEnv(deploymentEnvironment),
    ...readClientChannelEnv(),
  };
};
