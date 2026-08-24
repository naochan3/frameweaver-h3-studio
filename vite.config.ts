import { defineConfig, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { discordAuthPlugin } from './server/discord-auth.js'
import { createRewriterGateway } from './src/server/rewriter-gateway.ts'
import { createViteRewriterMiddleware } from './src/server/vite-rewriter-middleware.ts'

// ComfyUI バックエンド(PC上の localhost:8188)。
// 同一LAN内の別端末(スマホ等)からアクセスするため、ブラウザは直接叩かず
// Vite の /comfy プロキシ経由でPC上のComfyUIへ中継する(CORS不要・127.0.0.1問題を回避)。
const COMFY_TARGET = process.env.COMFY_TARGET ?? 'http://127.0.0.1:8189'
const comfyProxy: Record<string, string | ProxyOptions> = {
  '/comfy': {
    target: COMFY_TARGET,
    changeOrigin: true,
    ws: true,
    // ComfyUIはWebSocketのOriginを検査する。外部のTailnetホスト名や任意の
    // Vite開発ポートをそのまま渡すと403になるため、同一上流Originへ正規化する。
    headers: { origin: new URL(COMFY_TARGET).origin },
    rewrite: (path) => path.replace(/^\/comfy/, ''),
  },
}
const rewriterMiddleware = createViteRewriterMiddleware(createRewriterGateway())
const rewriterPlugin = {
  name: 'frameweaver-rewriter-gateway',
  configureServer(server: { middlewares: { use: (handler: typeof rewriterMiddleware) => void } }) {
    server.middlewares.use(rewriterMiddleware)
  },
  configurePreviewServer(server: { middlewares: { use: (handler: typeof rewriterMiddleware) => void } }) {
    server.middlewares.use(rewriterMiddleware)
  },
}
// https://vite.dev/config/
export default defineConfig({
  plugins: [discordAuthPlugin(), react(), tailwindcss(), rewriterPlugin],
  server: {
    host: '127.0.0.1',
    port: 5180,
    strictPort: true,
    allowedHosts: ['rtx4090.tail37947a.ts.net'],
    proxy: {
      '/api': {
        target: process.env.FRAMEWEAVER_API_URL ?? 'http://127.0.0.1:5181',
        changeOrigin: true,
      },
      ...comfyProxy,
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 5180,
    proxy: comfyProxy,
  },
})
