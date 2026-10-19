# 应用图标

这里是 Tauri 打包必需的五枚图标，已按 `tauri.conf.json` 的 `bundle.icon` 命名落地：

```
32x32.png  128x128.png  128x128@2x.png  icon.png（1024）  icon.ico（16/32/48/64/128/256 六帧）
```

源图与 `Client/` 用同一张品牌资产：`Client/public/assets/favicon.png`（1114×1080，带 alpha，
contain 方式补成正方形后缩放，不重画、不加边）。图标属于品牌资产，桌面端不得另画一套。

## 重新生成

换 logo 后在仓库根执行（`icon.ico` 由该命令一并产出）：

```powershell
node -e "const s=require('sharp')" # 需要 sharp 时优先用官方 CLI，它同时产出 .ico 与商店方块图
pnpm dlx @tauri-apps/cli icon Client/public/assets/favicon.png --output Desktop/src-tauri/icons
```

`tauri icon` 要求源图为正方形且边长 ≥1024；favicon 原图是 1114×1080，先用任意工具 contain
补方（透明背景）再喂给它。`icon.ico` 必须含 16/32/48/64 多尺寸，NSIS 安装向导与任务栏都用它。

## 为什么缺文件时 CI 才发现

`cargo check` / `cargo build` 不读图标，只有 `tauri build` 打包阶段才校验，所以缺文件在类型
与编译门禁里都是绿的，一直到打包才炸。CI 的 Desktop Build 作业跑的就是完整打包，能兜住这条。
