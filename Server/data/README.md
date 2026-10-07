# Bangumi 数据库

`bangumi-character.sqlite` 与 `bangumi-song.sqlite` **不进 Git**（曾走 LFS，
把账户的 GitHub LFS 带宽额度吃穿），现由 Cloudflare R2 分发：

- 基址：`https://data.oblivionis.me`（R2 桶 `bakagame-data` 的公开自定义域）
- 校验：`SHA256SUMS` 由每周发布流程**最后**上传，作为一致性锚点

## 本地开发取数

```bash
cd Server/data
curl -fLO https://data.oblivionis.me/bangumi-character.sqlite
curl -fLO https://data.oblivionis.me/bangumi-song.sqlite
curl -fLO https://data.oblivionis.me/SHA256SUMS
sha256sum --check --strict SHA256SUMS
```

## 更新链路

`bangumi-data.yml`（北京时间每周一 05:00，或 CCB-TagsCI 派发）从
`bangumi/Archive` dump 构建新库后上传 R2；CI（ci.yml）与生产部署
（deploy.yml）按 `SHA256SUMS` 校验后取用，校验和未变化时零下载复用。
