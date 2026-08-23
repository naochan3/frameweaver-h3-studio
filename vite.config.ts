import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { discordAuthPlugin } from './server/discord-auth.js'
import { createRewriterGateway } from './src/server/rewriter-gateway.ts'
import { createViteRewriterMiddleware } from './src/server/vite-rewriter-middleware.ts'

// ComfyUI バックエンド(PC上の localhost:8188)。
// 同一LAN内の別端末(スマホ等)からアクセスするため、ブラウザは直接叩かず
// Vite の /comfy プロキシ経由でPC上のComfyUIへ中継する(CORS不要・127.0.0.1問題を回避)。
const COMFY_TARGET = 'http://127.0.0.1:8188'
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
      '/api/fleet': {
        target: process.env.FRAMEWEAVER_API_URL ?? 'http://127.0.0.1:5181',
        changeOrigin: true,
      },
      '/comfy': {
        target: COMFY_TARGET,
        changeOrigin: true,
        ws: true,
        rewrite: (p) => p.replace(/^\/comfy/, ''),
        configure: (proxy) => {
          // ComfyUIがloopback時に行うHost/Origin照合を、同一ホストのプロキシ要求として通す。
          proxy.on('proxyReq', (request) => request.setHeader('origin', COMFY_TARGET))
          proxy.on('proxyReqWs', (request) => request.setHeader('origin', COMFY_TARGET))
        },
      },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 5180,
  },
})
