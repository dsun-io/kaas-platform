import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  // vitest 4 + Vite 8 的转换器是 **oxc**（不再是 esbuild）：`tsconfig.json` 里的
  // `"jsx": "preserve"`（Next 构建需要）会被照搬 ⇒ JSX 原样留在代码里，
  // 任何**导入 .tsx 源码**的测试都会在 import 阶段报
  // "Failed to parse source for import analysis ... jsx to preserve"。
  // 这里显式指定 JSX 运行时，组件测试才跑得起来。
  // 注意必须用 `oxc`：Vite 8 下 `esbuild: { jsx: ... }` 会被忽略并告警
  // （"Both esbuild and oxc options were set"）。该选项只影响 .tsx 的 JSX 转换，
  // 对既有 .ts 测试无影响。
  oxc: { jsx: { runtime: 'automatic', importSource: 'react' } },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**'],
    setupFiles: [],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
      '@contracts': resolve(__dirname, '../shared/contracts'),
    },
  },
});
