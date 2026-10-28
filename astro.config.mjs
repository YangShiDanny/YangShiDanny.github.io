import { defineConfig } from 'astro/config';
import Compress from "@playform/compress";
import react from '@astrojs/react';
import { createReadStream, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

/* 本地 Pyodide：`node scripts/pyodide-vendor.cjs <tar.bz2>` 会把
   pyodide-core 解到 vendor/pyodide/。这个目录故意不放进 public/ ——
   放进去每次 build 都会把 13MB 原件抄进 dist 一起发出去。dev 下由
   这个中间件按 /LumeOS/vendor/pyodide/ 提供服务，线上没有这个目录，
   前端探测到 404 就自动退回 IndexedDB / CDN。 */
const PY_VENDOR_URL = '/LumeOS/vendor/pyodide/';
const PY_VENDOR_DIR = fileURLToPath(new URL('./vendor/pyodide/', import.meta.url));
const PY_TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.zip': 'application/zip'
};

export default defineConfig({
  // GitHub Pages 用户站（根路径）：https://yangshidanny.github.io/
  site: 'https://yangshidanny.github.io',
  // 开启HTML压缩（Astro7默认是jsx，这里显式打开）
  compressHTML: true,
  vite: {
    plugins: [
      {
        /* dev 专属：public/ 子目录的 index.html 兜底。
           Astro dev 不为 public 下的目录路径提供 index.html
           （/LumeOS/ 会 404，线上由静态服务器兜底，dev 只能自己补）。
           只在开发服务器里把 /LumeOS/ 重写到 /LumeOS/index.html，
           不影响构建产物。 */
        name: 'lumeos-public-index',
        apply: 'serve',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            const url = (req.url || '').split('?')[0];

            /* 本地 pyodide 运行时（vendor/pyodide/）：dev 专属，
               见文件顶部的说明。wasm 要 application/wasm，
               instantiateStreaming 才肯吃。 */
            if (url.startsWith(PY_VENDOR_URL)) {
              const rel = decodeURIComponent(url.slice(PY_VENDOR_URL.length));
              const file = join(PY_VENDOR_DIR, normalize(rel));
              if (!file.startsWith(PY_VENDOR_DIR)) {
                res.statusCode = 403;
                res.end('forbidden');
                return;
              }
              let st = null;
              try {
                st = statSync(file);
              } catch (e) {
                st = null;
              }
              if (!st || !st.isFile()) {
                res.statusCode = 404;
                res.end('pyodide vendor not found — run `node scripts/pyodide-vendor.cjs <tar.bz2>`');
                return;
              }
              res.setHeader('Content-Type', PY_TYPES[extname(file).toLowerCase()] || 'application/octet-stream');
              res.setHeader('Content-Length', st.size);
              res.setHeader('Cache-Control', 'no-store');
              res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
              if (req.method === 'HEAD') {
                res.end();
                return;
              }
              const stream = createReadStream(file);
              stream.on('error', () => res.destroy());
              stream.pipe(res);
              return;
            }

            if (url && /^\/LumeOS\/?$/.test(url)) {
              req.url = req.url.endsWith('/') ? req.url + 'index.html' : req.url + '/index.html';
            }
            next();
          });
        }
      }
    ],
    build: {
      minify: true,
      // 不输出sourcemap
      sourcemap: false,
    },
    css: {
      lightningcss: {
        // 关键：开启颜色简写，#aabbcc → #abc（条件满足时才转换）
        minify: {
          color: true
        }
      }
    }
  },
  integrations: [
    react({
      jsxImportSource: 'react'
    }),
    Compress({
      HTML: true,
      CSS: true,
      JavaScript: true,
      SVG: true,
      Image: false, // 图片压缩如果你不需要可以关掉，开了会慢很多
      JSON: true
    })
  ],
  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'zh'],
    routing: {
      prefixDefaultLocale: false // 英文根路径 /，中文 /zh/
    }
  }
});
