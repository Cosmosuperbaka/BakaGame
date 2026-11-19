// 故事健康检查的豁免清单：只放过「已知且有意」的报错，比如故事本身就在演示错误态。
// 每条三个字段都必填：id 是静态构建 index.json 里的故事编号，fragment 是报错文本里的一段，
// reason 写清为什么这条报错是预期的。两个条件同时命中才豁免，因此不存在整类静音。
// 清单应当尽量为空：能改好的故事一律改故事，不要往这里加。

// 这几个故事都输入了完整 QQ 号，组件据此去站外 qlogo 取头像；故事自己就写明「截图环境拦掉外网，
// 头像按取不到落回同尺寸的占位圆」，所以被拦下的那条资源报错是预期结果，不是故事失效。
const QQ_AVATAR_BLOCKED =
  "登录弹窗按 QQ 号取站外 qlogo 头像，检查环境拦掉外网，头像落回占位圆，这条资源报错是预期的";

export const EXEMPTIONS = [
  { id: "账号-logindialog--identified", fragment: "net::ERR_FAILED", reason: QQ_AVATAR_BLOCKED },
  { id: "账号-logindialog--sending", fragment: "net::ERR_FAILED", reason: QQ_AVATAR_BLOCKED },
  { id: "账号-logindialog--send-failed", fragment: "net::ERR_FAILED", reason: QQ_AVATAR_BLOCKED },
  { id: "账号-logindialog--code-step", fragment: "net::ERR_FAILED", reason: QQ_AVATAR_BLOCKED },
  { id: "账号-logindialog--register", fragment: "net::ERR_FAILED", reason: QQ_AVATAR_BLOCKED },
  {
    id: "页面-主页--default",
    fragment: "404 (Not Found)",
    reason:
      "静态 Storybook 没有后端，站点配置接口 /api/site/config 必然 404；组件回落到全部模式开放，正是这个故事要展示的状态",
  },
];
