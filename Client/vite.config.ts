import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { execSync } from 'child_process'
import fs from 'fs'
import { preparePublicWebp } from './scripts/prepare-public-webp.mjs'

// ==================== Vite 插件：构建时注入提交历史 ====================
// 以虚拟模块提供数据，随 JS 产物一同带 hash：
// 落到 public/ 的固定文件名会被 CDN 按不变资源长期缓存，内容更新后前端取不到。

const COMMIT_HISTORY_ID = 'virtual:commit-history'

function commitHistoryPlugin() {
  const resolvedId = '\0' + COMMIT_HISTORY_ID

  function collect() {
    let currentCommit = 'dev'
    let commits: Array<{ hash: string; message: string; date: string; author: string }> = []

    try {
      // 获取最新 commit hash
      currentCommit = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim()

      // 获取最近 30 条 commit（用 \x00 分隔字段，\x1F 分隔记录）。
      // 日期用 ISO 严格格式带时区，前端才能算出「几秒前 / 几分钟前」这种精度；
      // --date=short 只到天，相对时间会全部退化成「今天」。
      const raw = execSync(
        'git log -n 30 --date=iso-strict --format=%H%x00%s%x00%ad%x00%an%x1F',
        { encoding: 'utf-8' }
      )

      commits = raw
        .split('\x1F')
        .map((r) => r.trim())
        .filter(Boolean)
        .map((record) => {
          const parts = record.split('\x00')
          return {
            hash: (parts[0] ?? '').substring(0, 7),
            message: (parts[1] ?? '').trim(),
            date: (parts[2] ?? '').trim(),
            author: (parts[3] ?? '').trim(),
          }
        })
    } catch { /* git 不可用时退化为空数组 */ }

    // 不输出版本号：展示版本号一律以 changelog.json 为准，
    // 免得 package.json 与更新日志各说一套。
    return { generatedAt: new Date().toISOString(), currentCommit, commits }
  }

  return {
    name: 'commit-history',
    resolveId(id: string) {
      return id === COMMIT_HISTORY_ID ? resolvedId : null
    },
    load(id: string) {
      if (id !== resolvedId) return null
      return `export default ${JSON.stringify(collect())}`
    },
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: {
            name: 'bakagame-build',
            content: collect().currentCommit,
          },
          injectTo: 'head' as const,
        },
      ]
    },
  }
}

// ==================== Vite 插件：扫描表情包目录生成清单 ====================
// 以虚拟模块提供数据，随 JS 产物一同带 hash：
// 落到 public/ 的固定文件名会被 CDN 按不变资源长期缓存，新增表情包后老用户取不到。

const STICKER_EXTENSIONS = ['.gif', '.png', '.apng', '.webp', '.jpg', '.jpeg']

/**
 * 判断单个文件是否为动图。扩展名只是第一道线索：
 * info.txt 里的下载地址一律写成 .png，动图包也不例外，所以只能看磁盘上的真实文件。
 * APNG 与动态 WebP 都可能顶着静态图的扩展名，因此再嗅一次容器里的动画标记块。
 */
function detectAnimated(filePath: string, ext: string) {
  if (ext === '.gif' || ext === '.apng') return true
  if (ext !== '.png' && ext !== '.webp') return false

  try {
    // 动画标记块都在文件头部：APNG 的 acTL 必须在第一帧之前，WebP 的 ANIM 紧跟 VP8X。
    const head = Buffer.alloc(4096)
    const fd = fs.openSync(filePath, 'r')
    const read = fs.readSync(fd, head, 0, head.length, 0)
    fs.closeSync(fd)

    const chunk = head.subarray(0, read)
    return ext === '.png' ? chunk.includes('acTL') : chunk.includes('ANIM')
  } catch {
    return false
  }
}

/**
 * 从 info.txt 解析包的显示名与表情排序。
 * `# 名称：xxx` 给出包名，`# [包名_表情名]` 的出现顺序即权威排序。
 */
function parseInfoFile(packDir: string) {
  const order: string[] = []
  let displayName = ''

  try {
    const raw = fs.readFileSync(path.join(packDir, 'info.txt'), 'utf-8')

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('#')) continue

      const nameMatch = trimmed.match(/^#\s*名称[：:]\s*(.+)$/)
      if (nameMatch) {
        displayName = nameMatch[1].trim()
        continue
      }

      // 形如 `# [夜愿华章表情包_鼓掌]`，取下划线后的表情名。
      const itemMatch = trimmed.match(/^#\s*\[(.+)\]$/)
      if (itemMatch) {
        const key = itemMatch[1].slice(itemMatch[1].indexOf('_') + 1).trim()
        if (key && !order.includes(key)) order.push(key)
      }
    }
  } catch { /* 没有 info.txt 时退化为按文件名排序 */ }

  return { displayName, order }
}

const STICKER_MANIFEST_ID = 'virtual:sticker-manifest'

function stickerManifestPlugin(publicDir: string) {
  const resolvedId = '\0' + STICKER_MANIFEST_ID

  function collect() {
    const emojiDir = path.join(publicDir, 'emojis')

    let packs: unknown[] = []

    try {
      packs = fs
        .readdirSync(emojiDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
          const packDir = path.join(emojiDir, entry.name)
          const { displayName, order } = parseInfoFile(packDir)

          const items = fs
            .readdirSync(packDir, { withFileTypes: true })
            .filter((file) => file.isFile())
            .filter((file) => STICKER_EXTENSIONS.includes(path.extname(file.name).toLowerCase()))
            .map((file) => {
              const ext = path.extname(file.name).toLowerCase()
              const base = path.basename(file.name, path.extname(file.name))
              // 文件名形如 `[包名_表情名]`，去掉方括号后取下划线之后的部分作表情名。
              const inner = base.replace(/^\[/, '').replace(/\]$/, '')
              const underscore = inner.indexOf('_')
              const key = (underscore >= 0 ? inner.slice(underscore + 1) : inner).trim()

              return {
                key,
                label: key,
                path: `/emojis/${encodeURIComponent(entry.name)}/${encodeURIComponent(file.name)}`,
                animated: detectAnimated(path.join(packDir, file.name), ext),
              }
            })
            // info.txt 里列出的按其顺序排在前，未列出的按名称追加在后。
            .sort((left, right) => {
              const leftIndex = order.indexOf(left.key)
              const rightIndex = order.indexOf(right.key)
              if (leftIndex !== rightIndex) {
                if (leftIndex < 0) return 1
                if (rightIndex < 0) return -1
                return leftIndex - rightIndex
              }
              return left.key.localeCompare(right.key, 'zh-Hans-CN')
            })

          return {
            name: displayName || entry.name,
            dir: entry.name,
            // 代表图取排序后的首个表情，保证每个包的标签图稳定且互不相同。
            preview: items[0]?.path ?? '',
            // 整包都是动图时才在标签上打角标；混装包只在具体表情上标。
            animated: items.length > 0 && items.every((item) => item.animated),
            items,
          }
        })
        .filter((pack) => (pack.items as unknown[]).length > 0)
    } catch { /* 目录不存在时输出空清单，前端表情按钮自然为空 */ }

    return { generatedAt: new Date().toISOString(), packs }
  }

  return {
    name: 'sticker-manifest',
    resolveId(id: string) {
      return id === STICKER_MANIFEST_ID ? resolvedId : null
    },
    load(id: string) {
      if (id !== resolvedId) return null
      return `export default ${JSON.stringify(collect())}`
    },
  }
}

export default defineConfig(async () => {
  const publicDir = await preparePublicWebp()

  return {
    publicDir,
    plugins: [react(), tailwindcss(), commitHistoryPlugin(), stickerManifestPlugin(publicDir)],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        // 共享定义唯一副本在 Server/src/shared/：服务端部署时只挂载 Server 目录，
        // 定义必须落在其内部才能被解析。这里显式指向它，不再经由 node_modules 链接。
        '@bakagame/shared': path.resolve(__dirname, '../Server/src/shared/index.ts'),
      },
    },
  }
})
