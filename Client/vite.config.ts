import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import fs from 'fs'

// ==================== Vite 插件：扫描表情包目录生成 sticker-manifest.json ====================

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

function stickerManifestPlugin() {
  return {
    name: 'sticker-manifest',
    buildStart() {
      const publicDir = path.resolve(__dirname, 'public')
      const emojiDir = path.join(publicDir, 'emojis')
      const outFile = path.join(publicDir, 'sticker-manifest.json')

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

      fs.writeFileSync(
        outFile,
        JSON.stringify({ generatedAt: new Date().toISOString(), packs }, null, 2)
      )
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), stickerManifestPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // 共享定义唯一副本在 Server/src/shared/：服务端部署时只挂载 Server 目录，
      // 定义必须落在其内部才能被解析。这里显式指向它，不再经由 node_modules 链接。
      '@bakagame/shared': path.resolve(__dirname, '../Server/src/shared/index.ts'),
    },
  },
})
