import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { execSync } from 'child_process'
import fs from 'fs'
import { preparePublicWebp, stickerAssetUrl } from './scripts/prepare-public-webp.mjs'
import { PAGE_META, SITE_NAME, SITE_ORIGIN } from './src/data/PageMeta'

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

function stickerManifestPlugin(emojiDir: string) {
  const resolvedId = '\0' + STICKER_MANIFEST_ID

  function collect() {
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
              const filePath = path.join(packDir, file.name)

              return {
                key,
                label: key,
                path: stickerAssetUrl(
                  path.relative(emojiDir, filePath),
                  fs.readFileSync(filePath),
                ),
                animated: detectAnimated(filePath, ext),
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

// ==================== Vite 插件：静态图片 WebP 自动映射 ====================
// 允许源码中直接使用真实源文件路径（如 /assets/Faker.png），
// 开发模式下通过中间件自动透明 rewrite 到 .webp，
// 构建打包时通过 transform 自动改写 HTML 与代码中的路径至最终 .webp 产物。

export function webpAssetPlugin(assetMap: Record<string, string>) {
  return {
    name: 'webp-asset-mapping',
    configureServer(server: { middlewares: { use: (fn: (req: { url?: string }, _res: unknown, next: () => void) => void) => void } }) {
      server.middlewares.use((req, _res, next) => {
        if (req.url) {
          const [pathname, query] = req.url.split('?')
          const target = assetMap[pathname]
          if (target) {
            req.url = target + (query ? `?${query}` : '')
          }
        }
        next()
      })
    },
    transformIndexHtml(html: string) {
      let transformed = html
      for (const [sourcePath, targetPath] of Object.entries(assetMap)) {
        transformed = transformed.replaceAll(sourcePath, targetPath)
      }
      return transformed.replace(/<link\b([^>]*\brel=["']icon["'][^>]*\bhref=["'][^"']*\.webp["'][^>]*)>/gi, (match) => {
        return match.replace(/type=["']image\/[a-z0-9+]+["']/i, 'type="image/webp"')
      }).replace(/<link\b([^>]*\bhref=["'][^"']*\.webp["'][^>]*\brel=["']icon["'][^>]*)>/gi, (match) => {
        return match.replace(/type=["']image\/[a-z0-9+]+["']/i, 'type="image/webp"')
      })
    },
    transform(code: string, id: string) {
      if (id.includes('node_modules') || id.startsWith('\0')) return null

      let hasMatch = false
      for (const sourcePath of Object.keys(assetMap)) {
        if (code.includes(sourcePath)) {
          hasMatch = true
          break
        }
      }
      if (!hasMatch) return null

      let transformed = code
      for (const [sourcePath, targetPath] of Object.entries(assetMap)) {
        transformed = transformed.replaceAll(sourcePath, targetPath)
      }
      return {
        code: transformed,
        map: null,
      }
    },
  }
}

// ==================== Vite 插件：静态外壳注入（可收录路由） ====================
// 本站是纯前端 SPA，构建产物的 <div id="root"> 是空的：执行 JS 的爬虫能自己渲染，
// 不执行 JS 的爬虫（百度为主）只能读到空壳。此插件在构建末尾把 PageMeta 里的正文与
// head 元信息写进各路由的 HTML，爬虫无需执行 JS 即可读到内容。
//
// 为什么是「构建期字符串注入」而不是无头浏览器预渲染：平台构建容器不提供 Chromium
// （实测报错 Executable doesn't exist ... chromium_headless_shell），而带着一个 150MB
// 的浏览器依赖去构建既慢又脆。本站可收录页面的正文本来就是数据（PageMeta），
// 直接由数据生成 HTML 更简单也更可靠。
//
// 注入的 head 标签全部带 data-static-seo="1"：这些标签只服务不执行 JS 的爬虫，
// 应用启动时会由 stripStaticSeo() 整体移除，再交给 react-helmet-async 写入当前路由的真值。
// 为什么不是「让 Helmet 接管」：react-helmet-async v3 在 React 19 下不走 DOM 复用路径
// （client.ts 里按 isEqualNode 复用旧标签的逻辑只在旧路径生效），它会直接渲染新标签，
// 静态标签留在原地就会变成重复 canonical —— 搜索引擎遇到重复 canonical 会判定整组失效。
// JSON-LD 例外：它用固定 id，Seo 的 useEffect 按同一 id 覆盖内容，不产生重复。
const STATIC_SEO_ATTRIBUTE = 'data-static-seo'
const STRUCTURED_DATA_ID = 'bakagame-structured-data'

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function staticShellPlugin() {
  return {
    name: 'static-shell',
    apply: 'build' as const,
    async closeBundle() {
      const distDir = path.resolve(__dirname, 'dist')
      const indexPath = path.join(distDir, 'index.html')
      const original = fs.readFileSync(indexPath, 'utf8')

      // 注入点缺失时宁可让构建失败，也不要静默产出一个空壳站点。
      if (!original.includes('<div id="root"></div>')) {
        throw new Error('静态外壳：dist/index.html 里找不到空的 #root 容器')
      }
      if (!original.includes('</head>')) {
        throw new Error('静态外壳：dist/index.html 里找不到 </head>')
      }

      const pages = PAGE_META.map((meta) => {
        const canonical = `${SITE_ORIGIN}${meta.path}`
        const description = escapeHtml(meta.description)
        const head = [
          `<meta name="description" content="${description}" ${STATIC_SEO_ATTRIBUTE}="1" />`,
          `<link rel="canonical" href="${canonical}" ${STATIC_SEO_ATTRIBUTE}="1" />`,
          `<meta name="robots" content="index,follow" ${STATIC_SEO_ATTRIBUTE}="1" />`,
          `<meta property="og:type" content="website" ${STATIC_SEO_ATTRIBUTE}="1" />`,
          `<meta property="og:site_name" content="${SITE_NAME}" ${STATIC_SEO_ATTRIBUTE}="1" />`,
          `<meta property="og:title" content="${SITE_NAME}" ${STATIC_SEO_ATTRIBUTE}="1" />`,
          `<meta property="og:description" content="${description}" ${STATIC_SEO_ATTRIBUTE}="1" />`,
          `<meta property="og:url" content="${canonical}" ${STATIC_SEO_ATTRIBUTE}="1" />`,
          `<script id="${STRUCTURED_DATA_ID}" type="application/ld+json">${JSON.stringify(meta.structuredData)}</script>`,
        ].join('\n    ')

        const body = [
          `<h1>${escapeHtml(meta.shell.h1)}</h1>`,
          ...meta.shell.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`),
          `<ul>${meta.shell.links
            .map((link) => `<li><a href="${link.href}">${escapeHtml(link.label)}</a></li>`)
            .join('')}</ul>`,
        ].join('')

        const html = original
          .replace('</head>', `  ${head}\n  </head>`)
          .replace('<div id="root"></div>', `<div id="root"><main>${body}</main></div>`)

        const segment = meta.path.replace(/^\//, '').replace(/\/$/, '')
        return {
          path: meta.path,
          html,
          // 双形态落盘：目录索引型主机与 clean URL 型主机各覆盖一种，别名 canonical 指向正式路径。
          outputs: segment === '' ? ['index.html'] : [`${segment}/index.html`, `${segment}.html`],
        }
      })

      // 先全部生成再落盘：index.html 同时是模板来源，边读边写会污染后续路由。
      for (const page of pages) {
        for (const output of page.outputs) {
          const target = path.join(distDir, output)
          fs.mkdirSync(path.dirname(target), { recursive: true })
          fs.writeFileSync(target, page.html)
        }
        const primary = path.join(distDir, page.outputs[0])
        const written = fs.readFileSync(primary, 'utf8')
        for (const marker of ['<div id="root"><main>', `${STATIC_SEO_ATTRIBUTE}="1"`, STRUCTURED_DATA_ID]) {
          if (!written.includes(marker)) {
            throw new Error(`静态外壳：${page.outputs[0]} 缺少 ${marker}`)
          }
        }
      }

      console.log(`静态外壳注入完成：${pages.map((page) => page.path).join('、')}`)
    },
  }
}

export default defineConfig(async () => {
  const { publicDir, assetMap } = await preparePublicWebp()
  const emojiDir = path.resolve(__dirname, './public/emojis')

  return {
    publicDir,
    // E2E 跑在 vite preview（生产构建）上：客户端生产包走同源相对路径，
    // preview 站内没有后端，把 /api（含 WebSocket 升级）转发给本地 Bun 服务。
    // 本地若存在 .env（VITE_SERVER_URL 指向 4850）则客户端直连，代理不参与。
    preview: {
      proxy: {
        '/api': {
          target: 'http://localhost:4850',
          changeOrigin: true,
          ws: true,
        },
      },
    },
    plugins: [
      react(),
      tailwindcss(),
      commitHistoryPlugin(),
      stickerManifestPlugin(emojiDir),
      webpAssetPlugin(assetMap),
      staticShellPlugin(),
    ],
    resolve: {
      alias: [
        { find: '@bakagame/shared', replacement: path.resolve(__dirname, '../Server/src/shared/Index.ts') },
        { find: '@/types', replacement: path.resolve(__dirname, './src/types/Index.ts') },
        { find: '@', replacement: path.resolve(__dirname, './src') },
      ],
    },
  }
})
