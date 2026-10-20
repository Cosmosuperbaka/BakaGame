import type { CapacitorConfig } from "@capacitor/cli";

/**
 * WebAuthn 的 rpID 是站点域名，页面 origin 必须是同一个域（或其子域）才能调起通行密钥。
 * 壳把内嵌资源挂到该域名上，origin 才与服务端 `PASSKEY_RP_ID` 对齐；域名随构建注入，
 * 仓库里不写生产值。未注入时保持 Capacitor 默认的 https://localhost（普通空房不受影响）。
 *
 * 只接受 https、默认端口、无路径的站点地址：IP 不能作 rpID；端口与路径会让壳内 origin
 * 与真实站点不一致，宁可不启用通行密钥，也不把页面挂到一个错误的口径上。
 */
const passkeyHostOf = (raw: string | undefined): string | undefined => {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return undefined;
    if (url.username || url.password || url.search || url.hash) return undefined;
    if (url.port && url.port !== "443") return undefined;
    if (url.pathname !== "/") return undefined;
    if (!url.hostname || url.hostname.includes("*")) return undefined;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname) || url.hostname.includes(":")) {
      return undefined;
    }
    return url.hostname;
  } catch {
    return undefined;
  }
};

const passkeyHost =
  passkeyHostOf(process.env.BAKA_PASSKEY_HOST) ?? passkeyHostOf(process.env.VITE_SERVER_URL);

// webDir 是 prepare-web.mjs 的产出（Client/dist 的复制件 + baka-bridge.js + 注入后的 index.html），
// 不要直接指向 ../Client/dist：那样桥接脚本不会被打包进去。
const config: CapacitorConfig = {
  appId: "website.baka.game",
  appName: "BakaGame",
  webDir: "dist-web",
  server: {
    androidScheme: "https",
    // 不做远程 URL 加载：移动端必须内嵌产物（商店审核 + 离线可用），见计划 P3.1
    // 资源仍由本地拦截器提供，只是把 origin 换成站点域名；/api/* 由 MainActivity
    // 的 WebViewClient 放行到真实网络，避免被本地资源服务当成 SPA 路由回 index.html。
    ...(passkeyHost ? { hostname: passkeyHost } : {}),
  },
  plugins: {
    // 本期不引入任何官方能力插件；桥接面只有 BakaChannel（原生侧直接注册，见 android/app）
  },
};

export default config;
