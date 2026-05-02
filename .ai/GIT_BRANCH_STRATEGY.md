# Git 分支策略与合并规范（铁律）

> **来源**：Nano Auto 规划，David 验收通过
> **版本**：v2.0 | 2026-05-02
> **适用仓库**：davidsun0124/kaas-platform
> **维护者**：David + Nano Auto + Runner
> 
> **违反此规范 = Nano验收直接打回**

---

## 一、设计原则

1. **main 永远可交付** - main分支必须随时可部署
2. **一任务一分支** - 每个Notion任务对应一个功能分支
3. **不设长期开发分支** - 禁止develop/staging等长期分支
4. **分支生命周期短** - 功能分支开发完成后立即合并到main
5. **与 Notion 状态机严格对齐** - 分支状态 = 任务状态

---

## 二、分支命名规范

### 2.1 命名格式
```
<type>/<简短描述>
```

| type | 说明 | 示例 |
|------|------|------|
| `feat/` | 新功能开发 | `feat/pricing-engine` |
| `fix/` | Bug修复 | `fix/router-import-error` |
| `docs/` | 纯文档任务 | `docs/branch-strategy` |
| `archive/` | 废弃但保留参考 | `archive/rpa-pdd-playwright` |

### 2.2 命名规则
- 全部小写，单词用 `-` 连接
- 描述部分 ≤ 4 个单词，见名知意
- 禁止使用中文、空格、特殊字符
- 关联 Notion 任务时，在 PR 描述中附任务链接（不需要放在分支名里）

### 2.3 废弃分支归档
- 已废弃但有参考价值的分支：打 tag → 删除远端分支
- 无参考价值的：直接删除

---

## 三、分支层级结构

```
main（永远可交付）
  ↑ 合并
  ├─ feat/xxx     # 功能开发分支
  ├─ fix/xxx      # Bug修复分支
  ├─ docs/xxx     # 纯文档分支
  └─ archive/xxx  # 废弃分支（tag后删除）
```

**关键决策：不设 develop 分支**

理由：
- 项目当前是单人开发 + AI 协作模式，没有多人并行开发的合并冲突压力
- Notion 状态机已经提供了完整的质量门禁（Nano验收 → David验收），替代了 develop 分支的"集成测试"角色
- 减少一层分支 = 减少一次合并 = 减少出错概率
- 未来团队扩展时，可考虑引入 develop 分支

---

## 四、与 Notion 状态机对齐

### 4.1 完整流转映射

| Notion 状态 | Git 操作 | 分支位置 |
|-------------|----------|----------|
| 编辑中 | 无分支 | David本地 |
| 待启动 | 无分支 | - |
| Nano规划 | 创建分支 `feat/xxx` | 从main拉出 |
| Runner开发 | 在分支上开发、提交 | `feat/xxx` |
| Nano验收 | 分支开发完成，等待合并 | `feat/xxx` |
| David验收 | 合并到 main | main + `feat/xxx` |
| 已完成 | 删除功能分支 | main |

### 4.2 流程图
```
Nano规划 → 创建分支 feat/xxx
  ↓
Runner开发 → 在分支上开发
  ↓
Nano验收 → 测试通过，准备合并
  ↓
David验收 → 合并到 main
  ↓
已完成 → 删除功能分支
```

### 4.3 纯文档任务
纯文档/分析任务（任务类型=文档）通常不涉及代码分支，产出直接写在 Notion 任务卡片的「📄 文档产出」选项卡内。如果文档变更涉及仓库内文件（如 README、Rules），则使用 `docs/` 前缀分支。

---

## 五、合并到 main 的准入标准

### 5.1 必须满足（全部 ✅ 才能合并）
- [ ] Nano 验收通过（执行日志中有 "开发完成" + 12项骨架 + 验证矩阵全 PASS）
- [ ] David 验收通过（任务状态已到「已完成」）
- [ ] 所有单元测试通过（`pytest tests/` 或等效命令）
- [ ] 无遗留 P0/P1 Open Questions
- [ ] Runner 执行日志完整（含自检清单、commit hash、变更文件清单）
- [ ] 无 lint 错误（如适用）

### 5.2 建议满足（非强制，但推荐）
- [ ] PR 描述中附上 Notion 任务链接
- [ ] PR 描述中附上关键变更说明
- [ ] 功能分支已 rebase 到最新 main（减少合并冲突）

---

## 六、合并流程（SOP）

### 6.1 常规合并（David 验收通过后）
```bash
# 1. 切到 main，拉取最新
git checkout main
git pull origin main

# 2. 合并功能分支（使用 --no-ff 保留分支历史）
git merge --no-ff feat/xxx -m "feat: 合并 xxx 功能到 main"

# 3. 推送 main
git push origin main

# 4. 删除远端功能分支
git push origin --delete feat/xxx

# 5. 删除本地功能分支
git branch -d feat/xxx
```

### 6.2 紧急修复（Hotfix）
适用场景：main 上发现严重 bug，需要绕过正常流程快速修复。

```bash
# 1. 从 main 拉出 hotfix 分支
git checkout main
git checkout -b hotfix/xxx

# 2. 修复并提交
git add .
git commit -m "hotfix: 修复 xxx 问题"

# 3. 合并回 main（可快速验证后可直接合并）
git checkout main
git merge --no-ff hotfix/xxx -m "hotfix: 合并 xxx 修复"
git push origin main

# 4. 删除 hotfix 分支
git branch -d hotfix/xxx
```

### 6.3 功能太大怎么拆？
如果一个任务预估工作量 > 1 周，应在 Nano 规划阶段拆分：
- 拆为多个子任务，每个子任务一条分支
- 子任务之间如有依赖，按依赖顺序逐个合并到 main
- **禁止"长期功能分支"存在 > 2 周不合并**

---

## 七、main 分支保护规则

### 7.1 GitHub 设置建议
| 规则 | 当前（单人+AI） | 未来（多人） |
|------|----------------|-------------|
| 禁止 force push | ✅ 必须启用 | ✅ |
| 禁止删除 main | ✅ 必须启用 | ✅ |
| 要求 PR 合并 | ❌ 暂不启用 | ✅ 启用 |
| 要求 review | ❌ 暂不启用 | ✅ 至少1人 |
| 要求状态检查通过 | ❌ 暂不启用 | ✅ 启用 CI |

### 7.2 未来团队扩展时升级
当团队 > 1 人开发时，启用：
- 禁止直接 push to main
- 所有合并必须通过 PR
- PR 需至少 1 人 review（可以是 Nano Auto 的验收记录）

---

## 八、违反处理

**以下行为视为违规**：
- ❌ 直接 push 到 main（未经合并流程）
- ❌ 功能分支长期存在 > 2 周不合并
- ❌ 合并时缺少 Nano/David 验收
- ❌ 合并后未删除功能分支
- ❌ 使用中文/空格作为分支名

**违规处理**：
1. 立即回退 main 到合并前
2. 重新走完整流程
3. 记录违规原因到 Runner 执行日志
4. Nano 验收打回

---

**文档结束。所有 Runner 必须严格遵守本规范。**
