# 交接文档 · 结构性缺口盘点与安全登记（2026-10-21）

> **性质**：本文是 2026-10-21「结构性缺口盘点 + 历史密钥安全登记」这一批工作的**唯一交接文档**。产出物已全部落库，本文只做「背景 → 做了什么 → 数据基线 → 剩余待办 → 接手注意」的交接，不重复正文细节。
> **接手入口**：先读本文 §3「产出物清单」定位文件，再读 `docs/STRUCTURAL_DEBT.md` 正文；本文不再维护，正文以 `STRUCTURAL_DEBT.md` 为唯一权威。

---

## 1. 这批工作为什么做（背景）

2026-10-21 之前，项目的问题对账体系（`PROBLEM_STATUS_2026-10-11.md` 滚动记录、`TODO.md` 唯一账本）覆盖的是**现象级问题**——「出了什么 bug、修了什么、验收数据是多少」。但有一层问题从未被专门建档：**结构性/战略性缺口**——代码架构本身欠了什么债、靠什么约束防止再欠。这些债散落在代码注释、commit message 和口头决策里，新接手者看不到全貌。

本次盘点补上这一层，产出 `docs/STRUCTURAL_DEBT.md`，登记 6 条结构性缺口（S-1~S-6），并新增静态门禁脚本防止继续累积。

同批还处理了用户提出的「仓库历史密钥明文」问题——`SECURITY_AUDIT_2026-10-19.md` 做过静态树审计，但**没有做全 git 历史 blob 扫描**，且没有给出「选哪条治理路径」的决策框架。本次补上（`STRUCTURAL_DEBT.md` §6），但**未执行任何清理动作**，只登记待用户拍板。

---

## 2. 关键发现（数据基线，2026-10-21 实测）

### 2.1 结构性缺口（对应 S-1~S-6）

| 编号 | 缺口 | 实测数据 | 免费版能否撑住治理 |
|---|---|---|---|
| **S-1** | 后端巨石 `backend/worker/src/main.py` | **5170 行**（精确计数，含空行；`Measure-Object -Line` 显示 4639 是只算非空行的口径，两者不矛盾）。44 个私有函数被 22 个兄弟模块硬引用（`_binding` 7 处、`_can_see_all` 4 处等）。每个 isolate 启动都要编译这 5170 行 + 2165 行 `chain.py` + 2014 行 `quote_api.py`，是冷启动 P1 裁剪项。 | ✅ 够（纯重构，不新增基础设施） |
| **S-2** | 循环依赖 + `# noqa: E402` 压制 | `chain.py:24`、`quote_api.py:48` 反向 `from main import ...`，`main.py` 末尾再 `import chain/quote_api` 挂载，形成双向循环依赖。`# noqa: E402` 全仓 **217 处**（生产源码 55 处，`tests/` 162 处属正常延迟 import）。 | ✅ 够（与 S-1 同一次重构） |
| **S-3** | TODO 锚点格式不统一、无反查索引 | 生产源码有 **52 处** TODO/FIXME/HACK（后端 31 + 前端 21），但格式是「TODO A1」「TODO A3」这类**任务编号**，不是「TODO(S-x) 结构性债编号」，无法反查是哪条债、修没修。 | ✅ 够（纯文档/注释纪律） |
| **S-4** | 裸 `except Exception` 88 处 / `print()` 残留 18 处 | `except Exception` 命中 **88 处**（`ws_files.py` 17、`chain.py` 9、`quote_api.py` 9、`main.py` 8、`ws_cron.py` 7）；`print()` 命中 **18 处**（`ws_cron.py` 10、`ws_files.py` 5、`ws_docs_ext.py` 3），全在生产 Worker 源码里。 | ✅ 够（纯代码质量治理） |
| **S-5** | 单人项目无 Code Review | `git log --format='%an'` 只有 **David Sun (566)** / **David (192)** 两个作者（同一邮箱），758 个 commit、11 次生产部署、46 项安全审计修复全部单人判定，无任何 `Reviewed-by:` 第二人。 | ⚠️ 勉强够（流程约束零成本，真人 review 依赖外部资源） |
| **S-6** | 技术选型无论证留痕 | raw asyncpg 而非 ORM、无 Redis/消息队列、Python Worker 而非 TS、「文件末尾 import 挂载」而非 `APIRouter`——这些都是合理取舍，但全仓库没有一份文档集中论证「为什么选这个、不选那个、什么条件下重新评估」。 | ✅ 够（纯文档，补 ADR） |

### 2.2 历史密钥明文（`STRUCTURAL_DEBT.md` §6）

| 凭据类型 | 泄露位置 | 当前状态 | 用户裁决 |
|---|---|---|---|
| Notion 集成令牌（`ntn_`） | `.codex/config.toml`（commit `c91cf0e50` 引入） | 已从当前树删除（`100e767`），**git 历史 37+ commit 可读** | 2026-10-20：不清理、不轮换，风险接受 |
| Neon 生产口令（`npg_` / `postgresql://user:pass@...neon.tech`） | `backend/.tools/list_columns.py` 等 4 个工具脚本（`5e78d9ce` 之前） | 已改 `KAAS_DSN` 环境变量占位（`fbced671`），**git 历史 37 个 commit 可读** | 2026-10-20：不轮换、不 filter-repo，风险接受 |
| GitHub PAT（`ghp_`） | `docs/PROBLEM_STATUS_2026-10-11.md:4432`（文档内已脱敏为 `<REDACTED>`） | 待确认是否曾在真实 commit 里明文出现 | 待补全历史扫描 |
| AWS Access Key（`AKIA`） | 仅测试文件，值为 AWS 官方文档示例 key | 无需处理 | 已排除 |
| Resend API Key（`re_`） | `.github/workflows/deploy.yml` 等，值为 `${{ secrets.RESEND_API_KEY }}` 引用而非明文 | 无需处理 | 已排除 |

**注意**：`SECURITY_AUDIT_2026-10-19.md` 是静态树审计（只看当前 commit），没做全历史 blob 扫描——Notion/Neon 能被发现是因为碰巧在当前树里还有残留，可能还有「早已从当前树删除、只存在于历史 commit」的凭据没被发现。`STRUCTURAL_DEBT.md` §6.2 给了 gitleaks/trufflehog 全历史扫描命令，**未执行**。

### 2.3 免费版撑不住、明确「先不动」的项

| 项 | 为什么免费版不够 | 什么条件下会动 |
|---|---|---|
| **冷启动根治** | Python Worker 的 Pyodide 引导 + ~800KB 源码编译是运行时架构决定的，Cloudflare Workers Free/Paid 跑同一个 Python 运行时，付费不会让 Python 冷启动变快（只会放宽超时阈值）。根治需迁 TS Worker（冷启动 ~50ms）——后端 13.7 万行 Python 要么重写、要么等 Pyodide 官方懒加载。 | 用户拍板「接受迁 TS Worker 的成本」或「Pyodide 官方支持模块级懒加载」，二者取一。 |
| **地理延迟根治** | 当前 Neon 生产库在 us-east-2，中国访问 RTT 215ms。Neon 免费档**支持**东京区域（ap-northeast-1），技术上免费版够；真正的阻塞是**停机窗口**（迁东京要停机 10–30 分钟）+ Hyperdrive/R2/Worker 区域联动确认。 | 用户拍板「接受停机窗口」并授权执行迁移。 |

---

## 3. 产出物清单（已落库，`git status` 可见）

| 文件 | 类型 | 状态 | 说明 |
|---|---|---|---|
| `docs/STRUCTURAL_DEBT.md` | **新建** | 未提交 | 168 行，S-1~S-6 详细登记 + 免费版优先级矩阵 + §3 免费版撑不住项 + §4 门禁说明 + §5 待拍板清单 + §6 历史密钥专章。**唯一权威正文**。 |
| `scripts/check-structural-debt.py` | **新建** | 未提交 | 静态结构债门禁，纯 Python + git，不连库不跑测试。检查 main.py 行数(≤4000)、单文件行数(≤3000)、noqa:E402 生产源码数(≤80)、except Exception(≤100)、print(≤20)、TODO 数量(仅打印)。已实测跑通：`--allow-known` 模式 ✅ exit 0（S-1/S-2 已登记债放行，新增违规 0）。 |
| `docs/TODO.md` | **修改** | 未提交 | D 组新增 S1 条目（结构性缺口账本建档）；G 组新增 G-9（历史密钥清理路径）、G-10（冷启动根治路径）、G-11（地理迁移停机窗口）三条待用户拍板。 |
| `docs/README.md` | **修改** | 未提交 | 索引表新增 `STRUCTURAL_DEBT.md` 行（第 58 行）。 |
| `docs/PROBLEM_STATUS_2026-10-11.md` | **修改** | 未提交 | 顶部「交接摘要」追加一条指向 `STRUCTURAL_DEBT.md`（第 1657 行）。 |

**未提交**：本批产出全部未 commit、未 push——需要新接手者（或用户）确认后再走 `AGENTS.md` 规则 1（改代码必须同步文档并 push main）。

---

## 4. 剩余待办（按优先级，全部登记在 `TODO.md`）

### P0（本批可做，纯文档/脚本，零风险）

| # | 事项 | 落点 | 工作量 |
|---|---|---|---|
| 1 | `AGENTS.md` 补「结构性债纪律」规则：①发现结构性债务先在 `STRUCTURAL_DEBT.md` 登记 S 条目再改代码；②生产 Worker 源码禁止裸 `print()`；③新增 `except Exception` 必须登记理由；④新增/替换基础设施组件前必须先写 ADR | `AGENTS.md` §1 或新建 § | 0.5 天 |
| 2 | 补 `docs/ARCH_DECISIONS.md`（ADR 简化版）：raw asyncpg、无 Redis、R2 优先/inline 兜底、Hyperdrive 直连无池、Python Worker 而非 TS、文件末尾 import 挂载——6 条已隐式决策补成显式 ADR | 新建 `docs/ARCH_DECISIONS.md` | 0.5 天 |
| 3 | 门禁脚本并入 CI：`.github/workflows/backend-test.yml` 与 `frontend-ci.yml` 各加一步 `python scripts/check-structural-debt.py --allow-known` | 两个 workflow 文件 | 0.1 天 |

### P1（下一批，代码重构，免费版够）

| # | 事项 | 落点 | 工作量 |
|---|---|---|---|
| 4 | S-1+S-2 第一步：44 个私有函数按域抽到 `backend/kaas_common/`（authz/numbering/tenant/fx/doc_common），`main.py` 与所有 `ws_*` 从共享内核 import，消除反向依赖 | `backend/worker/src/` + `backend/kaas_common/` | 1–2 天（1 个 PR） |
| 5 | S-1+S-2 第二步：`main.py` 内部按域分组路由（注释分段，暂不拆文件） | `backend/worker/src/main.py` | 0.5 天 |
| 6 | S-1+S-2 第三步：低频域（`tax_archives`/`ws_cron`）拆独立模块，改用 `APIRouter` 显式 `include_router`，取代文件末尾 import 挂载 | `backend/worker/src/` | 1–2 天（1 个 PR） |

### P2（随后，逐处判断，比 P1 慢）

| # | 事项 | 落点 | 工作量 |
|---|---|---|---|
| 7 | S-4 第二步：收敛 88 处 `except Exception`——`ws_files.py`（17 处，文件存储关键链路）优先，「有意兜底」保留 broad catch 但加注释说明，「无意吞异常」改具体类型或抛出 | `backend/worker/src/ws_files.py` 等 | 1–2 天 |
| 8 | S-3 存量治理：52 处 `TODO A1/A3/A8` 类任务编号注释，逐条核对——已完成的删注释，未完成的改成 `TODO(S-x)` 或 `TODO(TODO.md C12)` 格式 | 散在后端+前端 | 0.5 天 |
| 9 | S-5 流程约束落地：生产部署前清单做成 `TODO.md` §G 强制检查项；安全审计/越权修复类改动完成后在 `docs/QA_*_*.md` 明确标注「单人执行，未复核」 | `TODO.md` §G + `AGENTS.md` | 0.5 天 |

### ⛔ 明确不动（待用户拍板，已登记 TODO.md §G）

| # | 事项 | 拍板点 |
|---|---|---|
| G-9 | 历史密钥清理路径 | ①是否执行全历史 gitleaks/trufflehog 扫描（需先安装工具）；②三条路径（A 接受风险 / B 只轮换 / C 轮换+filter-repo 重写历史）选哪条；③若选 B/C，逐项授权轮换；④§6.4 四项防再犯约束（pre-commit gitleaks / CI gitleaks / .gitignore 加固 / 凭据命名纪律）是否本批落地。**用户 2026-10-20 口头已选 A（接受风险），待确认是否维持**。 |
| G-10 | 冷启动根治路径 | 接受迁 TypeScript Worker 的成本，还是等 Pyodide 懒加载支持。**免费版/付费版都不直接解决，需要架构迁移**。 |
| G-11 | 地理迁移停机窗口 | Neon 迁 ap-northeast-1（东京）的可接受停机时间窗口（预计 10–30 分钟）+ Hyperdrive/R2/Worker 区域联动确认。**Neon 免费档支持东京，技术上免费版够，阻塞在停机决策**。 |

---

## 5. 接手注意（踩过的坑，别再踩）

1. **`Measure-Object -Line` 会少算空行**——本文所有行数都是「精确物理行数」（含空行，`-split "`n"` 或 Python `sum(1 for _ in open())` 口径）。如果用 PowerShell `Measure-Object -Line` 复核，会看到 `main.py` 显示 4639 而不是 5170，**这不是数据错误，是口径不同**。
2. **`git ls-files` 的 `**` 通配在部分 Git 版本不展开**——`git ls-files 'backend/worker/src/**/*.py'` 可能只返回 3 个文件而不是全部。门禁脚本已改用「无通配 + 正则前缀过滤」规避（见 `check-structural-debt.py` 的 `git_ls_files_regex`）。
3. **PowerShell 5.1 默认 GBK 编码会把 UTF-8 emoji 打印成乱码**——跑门禁脚本前设 `$env:PYTHONUTF8='1'`，否则「✅」会触发 `UnicodeEncodeError`。
4. **工作区有并发改动**（2026-10-21 10:10–10:12）：`AGENTS.md`、`frontend/e2e/a11y.spec.ts`、`frontend/package.json`、`.github/workflows/frontend-ci.yml` 被另一条线修改（看起来是 UI 规范化 + a11y 任务，产出 `docs/UI_STANDARDS.md` + `frontend/scripts/ui-standards-check.cjs`）。**这批改动与结构性债账本互不冲突**（不同文件、不同主题），但提交前需要确认是不是同一批工作，避免混在一起 commit。
5. **门禁脚本默认模式会阻断**——不带 `--allow-known` 时，S-1（main.py 5170 行）和 S-2（noqa:E402 55 处）会触发 violation 导致 exit 1。日常开发用 `--allow-known`，S-1/S-2 治理完成后再收紧阈值。

---

*本文档由 2026-10-21 结构性缺口盘点任务生成，产出物已全部落库（未提交）。接手者先读 §3 定位文件，再读 `docs/STRUCTURAL_DEBT.md` 正文；本文不再维护。*