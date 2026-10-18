import type { CapacitorConfig } from "@capacitor/cli";

// webDir 是 prepare-web.mjs 的产出（Client/dist 的复制件 + baka-bridge.js + 注入后的 index.html），
// 不要直接指向 ../Client/dist：那样桥接脚本不会被打包进去。
const config: CapacitorConfig = {
  appId: "website.baka.game",
  appName: "BakaGame",
  webDir: "dist-web",
  // 保持默认 https://localhost 方案：与线上同源的 Cookie/会话走壳内 fetch 才能带上登录态
  server: {
    androidScheme: "https",
    // 不做远程 URL 加载：移动端必须内嵌产物（商店审核 + 离线可用），见计划 P3.1
  },
  plugins: {
    // 本期不引入任何官方能力插件；桥接面只有 BakaChannel（原生侧直接注册，见 android/app）
  },
};

export default config;
