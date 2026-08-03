import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { execSync } from 'child_process'
import fs from 'fs'

// ==================== Vite 插件：构建时生成 commit-history.json ====================

function commitHistoryPlugin() {
  return {
    name: 'commit-history',
    buildStart() {
      const publicDir = path.resolve(__dirname, 'public')
      const outFile = path.join(publicDir, 'commit-history.json')

      // 读取 package.json 中的版本号
      let currentVersion = '1.0.0'
      try {
        const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8')) as { version?: string }
        if (pkg.version) currentVersion = pkg.version
      } catch { /* ignore */ }

      let currentCommit = 'dev'
      let commits: Array<{ hash: string; message: string; date: string; author: string }> = []

      try {
        // 获取最新 commit hash
        currentCommit = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim()

        // 获取最近 30 条 commit（用 \x00 分隔字段，\x1F 分隔记录）
        const raw = execSync(
          'git log -n 30 --date=short --format=%H%x00%s%x00%ad%x00%an%x1F',
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

      const output = {
        generatedAt: new Date().toISOString(),
        currentVersion,
        currentCommit,
        commits,
      }

      fs.writeFileSync(outFile, JSON.stringify(output, null, 2))
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), commitHistoryPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
