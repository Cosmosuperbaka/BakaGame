# Bangumi 数据集与图床

`bangumi.sqlite`（单库，猜歌与 CCB 共用）与 `images/`（avif 图床分片 + 校验 `manifest.json`）
均**不进 Git**——曾走 Git LFS，把账户的 GitHub LFS 带宽额度吃穿。

## 投递与更新（2026-10 起）

1. **基线 = 本地一次性构建**（`tools/` 整体不进 Git，都在本地工作区运行）：
   - `tools/build_bangumi_db.py`：从 `bangumi/Archive` dump 构建结构、名称与关系；
   - `tools/refresh_subject_tags.py`：用 API 刷新作品标签并回填 `subjects.image`
     （dump 的 tags 被截断到 11 个，API 给 30 个）；
   - `tools/build_bangumi_images.py`：经 `bangumi.baka.website` 反代抓 avif
     （`Accept: image/avif`，断点续传，分 16 片）。
2. **投放**：
   - 图床目录连 `manifest.json` 一起上传到服务器 `Server/data/`；
   - 数据集上传服务器之外，**还需发布一份到 R2**（`tools/publish_bangumi_data.py`，本地运行）——
     CI 的 E2E 与生产首启的基线补发都从 `<CDN 基址>/files/bangumi/manifest.json` 的
     `dataset` 条目取它。
3. **此后由后端自行更新**：角色标签走 CCB-TagsCI 的增量 diff（`id_tags.diff.json`）、作品标签
   与封面地址走 API 刷新、新条目按首播日期窗口发现；每日 04:00 先备份数据库再跑维护任务，
   备份为 `bangumi.sqlite.backup`（只留一份）。
4. **CI 不生产数据、部署不碰数据**：原每周构建发布流程（`bangumi-data.yml`）已删除；部署只在
   服务器没有可用数据库时按上面的 R2 清单补发（已有库绝不替换，见
   [Agents/Deployment.md](../../Agents/Deployment.md)「数据分发」）。

> R2 对象命名保持 `bangumi/bangumi-dataset.<sha12>.sqlite` 风格：文件名带内容哈希 ⇒ CDN 缓存键
> 随内容变化；发布顺序永远是「先传对象、后传 manifest」，不存在「清单指向未就绪数据」的窗口。
