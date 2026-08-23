import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { createRewriterGateway } from './src/server/rewriter-gateway.ts'
import { createViteRewriterMiddleware } from './src/server/vite-rewriter-middleware.ts'

// ComfyUI バックエンド(PC上の localhost:8189)。
// 同一LAN内の別端末(スマホ等)からアクセスするため、ブラウザは直接叩かず
// Vite の /comfy プロキシ経由でPC上のComfyUIへ中継する(CORS不要・127.0.0.1問題を回避)。
const COMFY_TARGET = 'http://127.0.0.1:8189'
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
  plugins: [react(), tailwindcss(), rewriterPlugin],
  server: {
    host: true, // 0.0.0.0 で待受 → LAN内の別端末から http://<PCのIP>:5180 で開ける
    port: 5180,
    proxy: {
      '/comfy': {
        target: COMFY_TARGET,
        changeOrigin: true,
        ws: true,
        rewrite: (p) => p.replace(/^\/comfy/, ''),
      },
    },
  },
  preview: {
    host: true,
    port: 5180,
  },
})
