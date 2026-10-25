import { defineConfig } from 'astro/config';
import Compress from "@playform/compress";
import react from '@astrojs/react';

export default defineConfig({
  // GitHub Pages 用户站（根路径）：https://yangshidanny.github.io/
  site: 'https://yangshidanny.github.io',
  // 开启HTML压缩（Astro7默认是jsx，这里显式打开）
  compressHTML: true,
  vite: {
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
