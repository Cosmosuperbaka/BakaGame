# Bangumi 数据库

`bangumi-character.sqlite` 与 `bangumi-song.sqlite` **不进 Git**（曾走 LFS，
把账户的 GitHub LFS 带宽额度吃穿），现由 Cloudflare R2（`files` 桶）经
加速域 `cdn.baka.website` 分发。

## 三个设计要点

1. **版本化文件名**：对象名形如 `bangumi/bangumi-<kind>.<sha12>.sqlite`，
   每次发布内容变化 ⇒ 文件名变化 ⇒ CDN 缓存键全新，不会被旧缓存污染。
2. **manifest.json 是唯一一致性锚点**：记录当前版本的 `object / sha256 / size /
   target`。它在 ESA 上配置了**禁缓存**规则（`cache-cdn-manifest-nocache`），
   公开可读且实时生效；先传数据后传 manifest，不存在「清单指向未就绪数据」的窗口。
3. **凭证最小化**：R2 的 AK/SK / 端点 / 加速域基址全部存放在仓库 secrets
   （`R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_S3_ENDPOINT / R2_BUCKET /
   BANGUMI_DATA_CDN_BASE`），**只有每周发布流程（bangumi-data.yml）使用**；
   CI 与生产部署只 `curl` 公开 URL，生产机不持有任何 R2 凭证。

> URL 形态：`<CDN基址>/files/<对象名>`。中间的 `files` 段是 ESA 回源 S3
> 源站的桶段（ESA 会把 URL 首段当作源站桶名），与 R2 桶 `files` 物理同名。

## 本地开发取数

无需任何凭证：

```bash
mkdir -p Server/data && cd Server/data
curl -fLO https://cdn.baka.website/files/bangumi/manifest.json
for id in character song; do
  key=$(jq -r --arg id "$id" '.files[] | select(.id==$id) | .object' manifest.json)
  sha=$(jq -r --arg id "$id" '.files[] | select(.id==$id) | .sha256' manifest.json)
  curl -fLO "https://cdn.baka.website/files/$key"
  echo "$sha  $(basename "$key")" | sha256sum --check --strict -
done
```

## 更新链路

`bangumi-data.yml`（北京时间每周一 05:00，或 CCB-TagsCI 派发）从
`bangumi/Archive` dump 构建新库后按「版本化对象 → manifest → 删旧版」的
顺序发布；CI（ci.yml）与生产部署（deploy.yml）经 manifest 校验 sha256 后
取用，本地缓存副本校验和未变化时零下载复用。
