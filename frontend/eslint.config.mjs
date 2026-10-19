import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Next 16 移除了 `next lint`，ESLint 10 默认 flat config：
// 原 `.eslintrc.json`（extends next/core-web-vitals + no-explicit-any 的替代规则）
// 迁移到这里，规则语义保持：
//   - core-web-vitals + typescript 两套 Next 官方规则
//   - 禁止裸 `any`（项目约定：用 unknown + zod），用 no-restricted-syntax 表达
export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSAnyKeyword",
          message: "Use unknown + zod instead of any.",
        },
      ],
      // React Hooks v7（随 Next 16 的 eslint-config-next@16 带入）新增了两条"渲染纯度"
      // 规则。现有代码里是「useEffect 里刷新外部数据后 setState」与
      // 「首渲染取一次时间窗快照（Date.now）」两种既有模式；升级轮先降为 warning
      // 保留可见性（28 处），后续专门一轮按 React 19 推荐模式重构，不在升级提交里混改。
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
    },
  },
  globalIgnores([
    "**/.next*/**",
    "**/node_modules/**",
    "**/coverage/**",
    "**/test-results/**",
    "**/playwright-report/**",
    "**/public/**",
    "next-env.d.ts",
  ]),
]);
