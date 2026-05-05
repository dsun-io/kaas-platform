# KaaS 项目 · 项目约束与领域知识

> 适用于 Claude Code 当前开发阶段。
> 最后更新：2026-05-04

---

## R1. 项目上下文

### 项目定位
**KaaS（Knowledge as a Service）** — 为传统制造业提供 AI 岗位能力托管，当前落地丝网行业报价系统。

### 当前阶段
**v2 架构重构期** — 核心目标是报价/定价引擎（Quote Engine），基于真实业务数据驱动，前后端分离。

### 技术栈
- **后端**：Python 3.12+ / FastAPI / SQLAlchemy async / PostgreSQL / Redis
- **前端**：Next.js (React) / TypeScript / Tailwind CSS / TanStack Query / MSW
- **基础设施**：Docker Compose（PostgreSQL + Redis + MinIO + Backend）
- **共享契约**：`shared/contracts/` 下的 Zod schema（前后端类型共享）

### 代码仓库
- **GitHub**：`davidsun0124/kaas-platform`
- **本地**：`D:\MyProject\kaas-platform\`
- **结构**：
  ```
  ├── backend/               # FastAPI 后端
  │   ├── orchestrator/      # 主应用
  │   │   ├── app/
  │   │   │   ├── db/        # 模型 + 仓储层
  │   │   │   ├── services/  # 业务逻辑（报价引擎等）
  │   │   │   ├── routers/   # API 路由
  │   │   │   └── repositories/ # 数据访问
  │   │   ├── scripts/       # seed 数据脚本
  │   │   └── tests/         # 173 个测试
  │   └── docker-compose.yml
  ├── frontend/              # Next.js 前端
  │   └── src/
  │       ├── app/           # 页面组件
  │       └── lib/           # 工具库 + 测试
  ├── shared/contracts/      # Zod 契约（前后端共享）
  └── .claude/               # Claude Code 配置与规则
  ```

---

## R2. 协作模式

### 当前模式
直接由 **Claude Code + David** 协作，不再使用 Notion 任务流水线 / Nano Auto 三方协作流程。

### 任务流转
1. David 提出需求或问题
2. Claude Code 验证理解、设计方案
3. Claude Code 实现代码
4. Claude Code 运行测试验证
5. 双方确认完成

### 外部数据源
- **Notion**：通过 HTTPS REST API 直连（`api.notion.com/v1/`）读取数据，**不依赖 MCP 工具**
- **API Token**：保存在 `notion_token.md` 记忆文件中

---

## R3. 编码规范

### 通用规则
1. **密码/密钥从环境变量读取，禁止硬编码**
2. **DB 用 UTC 存储时间；业务层按 Asia/Shanghai 计算**
3. **必须输出完整可运行代码，禁止省略号和「自行补充」**
4. **不确定的地方列为 Open Questions，不要静默猜测**
5. **避免过早抽象**：三行相似代码好过不合适的封装
6. **INSERT-only 模式**：Event 表只追加不修改；Capability 表也应按此原则

### Python 规范
- 遵循 PEP 8，使用类型注解
- 关键业务逻辑写测试（验证矩阵全 PASS）
- 日志用 `logging` 模块，seed 脚本可用 `print`
- 种子数据必须标注 `source` 字段

### API 设计规范
- RESTful 风格
- 多租户通过 `X-Tenant-Id` 请求头隔离（同一 public schema，应用层隔离）
- 返回值用标准 JSON 格式

### DB 设计模式
- **松散耦合**：通过 `spec_hash` 字符串关联，不设外键
- **幂等 INSERT**：seed 脚本可重复运行不产生重复数据
- **不出售**：Event 表永恒保留，不出售、不 DELETE

---

## R4. 领域知识

### 丝网行业背景
- 安平丝网：中国丝网之乡，全国 70%+ 产量
- 产品多为非标定制，报价依赖多变量（丝径、孔距、高度、卷长）实时计算

### 当前业务品类
| 品类 | 说明 | 子类型 |
|------|------|--------|
| 牛栏网 |  cattle fence，拧编（上疏下密）/ 环扣（鹿网） | 丝径 2.0×1.8 / 1.8×1.8 / 2.2mm / 2.5mm |
| 勾花网 | chain link fence | — |
| 立柱 | fence posts，Y型直边 / Y型花边 | 7 个高度（1.3m–2.5m） |
| 石笼网 | gabion mesh（重型六角网） | 平台保留品类 |

### 报价模型
- **成本驱动**：`卷重(kg) × 成本价(元/kg) × 加价率 = 售价`
- **三档报价**：低配(×1.10) / 标准(×1.15) / 高配(×1.20)
- **运费**：顺丰零担 / 顺丰干配，`base_fee + max(0, weight - threshold) × per_kg`
- **税点**：报价默认不含税，开票加 3%（`tax_rate=0.03`）

---

## R5. Git 与交付规范

### 分支命名
- `feature/<功能名>` / `fix/<问题名>` — 全部小写，`-` 连接
- 当前分支：`feature/v2-refactor`

### 提交规范
- Commit 格式：`<type>(<scope>): <描述>`
  - type: feat / fix / docs / refactor / test / chore
  - 示例：`feat(seed): 添加联凯真实业务数据`

### 每次交付包含
1. 修改了什么（文件清单）
2. 验证结果（测试通过）
3. Open Questions（如有）

---

## R6. 测试要求

### 后端
- `pytest tests/` — 全部 173+ 测试必须通过
- 关键测试文件：
  - `test_pricing_service.py` — 定价计算
  - `test_quote_api.py` — 报价 API
  - `test_quote_integration.py` — 端到端报价
  - `test_spec_hash.py` — spec_hash 幂等

### 前端
- `npx tsc --noEmit` — TypeScript 编译无错误
- MSW mock handlers 可用于独立前端测试

---

## R7. 修改后重启动规则

修改后端代码后，如果涉及需要重启才能生效的变更（API 路由/服务逻辑/中间件/Docker 配置/依赖等），**直接执行 `docker compose restart kaas-backend`**，无需询问。

不涉及重启的变更（纯测试文件/seed 脚本/静态配置/文档等）跳过。

---

*规则文件结束。本文件反映当前 v2 重构阶段的项目实际架构。*

### 后端
- `pytest tests/` — 全部 173+ 测试必须通过
- 关键测试文件：
  - `test_pricing_service.py` — 定价计算
  - `test_quote_api.py` — 报价 API
  - `test_quote_integration.py` — 端到端报价
  - `test_spec_hash.py` — spec_hash 幂等

### 前端
- `npx tsc --noEmit` — TypeScript 编译无错误
- MSW mock handlers 可用于独立前端测试

---

*规则文件结束。本文件反映当前 v2 重构阶段的项目实际架构。*
