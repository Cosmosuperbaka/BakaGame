# 图标占位说明

本目录**故意不放图标文件**。`tauri.conf.json` 的 `bundle.icon` 已按 Tauri 标准命名引用：

```
icons/32x32.png
icons/128x128.png
icons/128x128@2x.png
icons/icon.png
icons/icon.ico
```

缺这些文件时 `cargo check` / `cargo build` 不受影响（图标只在打包阶段用），
但 `tauri build` 打安装包会直接报错，所以**首次打包前必须先生成**：

```powershell
# 源图：1024x1024 PNG（带 alpha），放在仓库外或 Client/public/assets 里取
pnpm dlx @tauri-apps/cli icon path\to\logo-1024.png
```

`tauri icon` 会把上面五个文件写进本目录，一次生成、之后不用管。
要手工做：`icon.ico` 必须含 16/32/48/64 多尺寸，NSIS 安装向导与任务栏都用它。

图标属于品牌资产，与 `Client/` 现有 favicon 保持同一张图，不要在桌面端另画一套。
