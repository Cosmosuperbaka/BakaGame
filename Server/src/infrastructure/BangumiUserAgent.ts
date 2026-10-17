/**
 * 访问 Bangumi API 的统一 User Agent。
 *
 * 官方规范（bangumi/api `docs-raw/user agent.md`）要求非浏览器使用者声明
 * 开发者个人 ID 与应用名称，开源项目附项目主页；`BakaGame/1.0` 这种
 * 「应用名/版本号」格式是官方点名的反例，可能被禁用。
 */
export const BANGUMI_USER_AGENT =
  "Cosmosuperbaka/BakaGame (https://github.com/Cosmosuperbaka/BakaGame)";
