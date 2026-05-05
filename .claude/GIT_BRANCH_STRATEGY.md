# Git 分支策略与合并规范

> **适用仓库**：davidsun0124/kaas-platform
> **版本**：v2.0 | 2026-05-04

---

## 一、设计原则

1. **main 永远可交付** — main 分支必须随时可部署
2. **禁止未经许可合并到 main** — 所有合并到 main 的操作必须经 David 明确批准，禁止 AI 擅自执行
3. **一任务一分支** — 每个功能对应一条功能分支
4. **分支生命周期短** — 功能分支开发完成后尽快合并到 main

---

## 二、分支命名规范

### 格式
```
<type>/<简短描述>
```

| type | 说明 | 示例 |
|------|------|------|
| `feature/` | 新功能开发 | `feature/pricing-engine` |
| `fix/` | Bug修复 | `fix/router-import-error` |
| `docs/` | 纯文档任务 | `docs/branch-strategy` |
| `refactor/` | 重构 | `refactor/v2-refactor` |

### 规则
- 全部小写，单词用 `-` 连接
- 描述部分 ≤ 4 个单词，见名知意
- 禁止使用中文、空格、特殊字符

---

## 三、分支层级

```
main（永远可交付）
  ↑ 合并
  ├─ feature/xxx     # 功能开发分支
  ├─ fix/xxx         # Bug修复分支
  └─ docs/xxx        # 纯文档分支
```

**不设 develop / staging 分支**（单人 + AI 协作模式不需要）。

---

## 四、合并到 main 的准入标准

- [ ] **David 明确批准合并** — 禁止 AI 擅自执行合并（铁律）
- [ ] 所有单元测试通过（`pytest tests/`）
- [ ] 前端 TypeScript 编译通过（`npx tsc --noEmit`）
- [ ] 无遗留 P0/P1 Open Questions

### 建议满足
- [ ] 功能分支已 rebase 到最新 main
- [ ] 关键变更已写在 commit message 中

---

## 五、合并流程

### 常规合并
```bash
git checkout main
git pull origin main
git merge --no-ff feature/xxx -m "feat: 合并 xxx 功能到 main"
git push origin main
git branch -d feature/xxx           # 删除本地分支
git push origin --delete feature/xxx # 删除远端分支
```

### Hotfix
```bash
git checkout main
git checkout -b hotfix/xxx
# 修复...
git commit -m "fix: 修复 xxx 问题"
git checkout main
git merge --no-ff hotfix/xxx
git push origin main
git branch -d hotfix/xxx
```

### 大功能拆分
- 预估 > 1 周的工作应拆为多个子任务
- 每个子任务一条分支，按依赖顺序逐个合并到 main
- 禁止功能分支存在 > 2 周不合并

---

## 六、分支保护

| 规则 | 当前（单人+AI） |
|------|----------------|
| 禁止 force push | ✅ |
| 禁止删除 main | ✅ |
| 禁止 AI 擅自合并到 main | ✅ 必须经 David 批准 |
| 当前分支 `feature/v2-refactor` | 工作分支 |

---

*策略文件结束。所有开发必须遵守分支命名和合并流程。*
