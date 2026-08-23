import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// ComfyUI バックエンド(PC上の localhost:8189)。
// 同一LAN内の別端末(スマホ等)からアクセスするため、ブラウザは直接叩かず
// Vite の /comfy プロキシ経由でPC上のComfyUIへ中継する(CORS不要・127.0.0.1問題を回避)。
const COMFY_TARGET = 'http://127.0.0.1:8189'
// プロンプト自動強化用の軽量LLM(Ollama)。8189同様プロキシで中継しCORS/127.0.0.1問題を回避
const OLLAMA_TARGET = 'http://127.0.0.1:11434'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
      '/ollama': {
        target: OLLAMA_TARGET,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/ollama/, ''),
      },
    },
  },
  preview: {
    host: true,
    port: 5180,
  },
})
