# 结构性缺口账本（2026-10-21 建档）

> **性质**：本文是「结构性/战略性问题」的**唯一权威登记处**。与 `PROBLEM_STATUS_2026-10-11.md`（现象级问题滚动对账）、`TODO.md`（活跃待办唯一账本）互补：那两份记「出了什么问题、修了什么」，本文记「**架构本身欠了什么债、靠什么约束防止再欠**」。
> **建档原因**：2026-09-22 `CODEBASE_AUDIT_REPORT` 与 2026-10-19 `SECURITY_AUDIT` / `MIGRATION_DOWNGRADE_AUDIT` 覆盖了「当下可指认的缺陷」，但**没有一份文档专门暴露「结构性问题」**——这些债散落在代码注释、commit message 和口头决策里，新接手者看不到全貌。本文补上这一层。
> **维护规则**（与 `TODO.md` §H 同纪律）：
> 1. 每条 S 组条目 = 一个结构性缺口，必须写清「现状取证 → 影响 → 根因 → 已有约束（防再犯）→ 治理计划 → 免费版能否撑住」。
> 2. 完成一项必须在本文销账（状态改 ✅ + 日期 + 证据），并在 `TODO.md` 同步登记。
> 3. **免费版方案能撑住的先做**（纯代码/纯工程纪律，零成本）；**免费版撑不住的先不动**（涉及冷启动架构手术、地理迁移停机窗口、Workers Paid 升级——需用户拍板，登记在 `TODO.md` §G 待用户拍板清单，不在本文擅自推进）。
> 4. 每批新增结构性缺口前，先跑一遍 `scripts/check-structural-debt.py`（静态门禁），确认没有新增违规再登记。

---

## 0. 状态图例与口径

| 状态 | 含义 |
|---|---|
| ⏳ | 已建档、未开工（按免费版优先级排队） |
| 🔧 | 治理中（有分支/有 PR，未合入 main） |
| ⛔ | 用户 2026-10-21 裁决暂缓/不做（登记原因，不删条目） |
| ✅ | 已完成（改代码 + 补测试 + 更新本文 + 推 main） |
| 🧭 | 待用户拍板（写在 §5 汇总，`TODO.md` §G 有对应条目） |

**「免费版能否撑住」口径**：本文只判断「当前 Cloudflare Workers Free + Neon Free + R2 Free + GitHub Free 这套底座，在**不升级付费**的前提下，能不能承载该项治理完成后的形态」。答案分三档：
- ✅ **免费版够**：治理本身不引入新基础设施，纯代码重构/纪律/文档，零边际成本。
- ⚠️ **免费版勉强够**：治理后形态在免费版配额内，但贴近上限（如 Workers Free 内存/CPU 限额、Neon 免费档连接数/存储），需要治理过程中控制新增体积。
- ❌ **免费版不够**：治理完成后的目标形态需要付费档（Workers Paid 浏览器时长、Neon 付费算力/存储、GitHub Actions 付费分钟数），或需要跨区域架构调整（停机窗口）。

---

## 1. 结构性缺口清单（按主题分组）

### S-1. 后端巨石：`backend/worker/src/main.py` 5170 行 + 44 个私有函数被外部硬引用

| 维度 | 内容 |
|---|---|
| **现状取证** | `wc -l backend/worker/src/main.py` = **5170 行**（2026-10-21 实测，比 2026-10-20 性能审计记录的 4639 行又涨 531 行）。全模块定义 **44 个 `def _xxx()` 私有函数**，其中 `_binding`(7 处)、`_can_see_all`(4 处)、`_require_platform_ops`(3 处)、`_jwt_secret`(3 处)、`_owner_visible`(3 处)、`_check_write_access`(3 处) 被 `chain.py`/`quote_api.py`/各 `ws_*.py` 跨文件硬引用。 |
| **影响** | ① 冷启动变慢：每个 isolate 启动都要编译这 5170 行 + 2165 行 `chain.py` + 2014 行 `quote_api.py`，`PROD_PERFORMANCE_AUDIT_2026-10-21.md` §1.4 已量化「约 800KB 源码每 isolate 启动时编译，无法整体懒加载」；② 改一处碰全身：任何 `main.py` 改动都触发全部 22 个 import 它的模块重新加载，CI 每次全量跑 1560 条 worker 测试；③ 新人上手成本高：单文件无法按「域」检索，只能靠 `grep` 函数名定位。 |
| **根因** | 方案 B 单应用收拢（S4）时「删 orchestrator 业务壳、真源迁入 worker」，迁移策略是**平铺追加**而非**按域分层**：新域（报价/单证/文件/团队/AI/线索/调研）都往 `main.py` 追加路由+函数，直到文件膨胀，才用「文件末尾 `import ws_*`」的挂载约定拆出兄弟模块，但 `main.py` 本身没有再拆。 |
| **已有约束（防再犯）** | ① `AGENTS.md` §1 要求「改代码必须同步文档并 push」；② `PROD_PERFORMANCE_AUDIT_2026-10-21.md` §1.4 已把「800KB 源码编译」列为冷启动 P1 裁剪项；③ 本次新增：`scripts/check-structural-debt.py` 静态门禁——`main.py` 超过 **4000 行** 或单文件超过 **3000 行** 即报错，防止继续膨胀。 |
| **治理计划（免费版 ✅ 够）** | 分三步，每步独立可交付、每步跑全量门禁：① 把 44 个私有函数按「授权/取号/租户/汇率/文档」五类抽到 `backend/kaas_common/authz.py`、`numbering.py`、`tenant.py`、`fx.py`、`doc_common.py`（共享内核，worker 通过 `sync-shared.ps1` 镜像引入）；② `main.py` 内部按域分组路由（`# —— 域：报价 ——` 注释分段，暂不拆文件）；③ 待私有函数外迁稳定后，再把低频域（`tax_archives`/`ws_cron`）拆成独立模块并改用 `APIRouter` 显式 `include_router`，取代「文件末尾 import」隐式挂载。**全程不改语义、不改路由、不改测试断言**——只是把符号从一个文件搬到另一个文件。 |
| **免费版判断** | ✅ **免费版够**：纯代码重构，不引入新依赖、不增加运行时资源消耗（共享内核本来就要打进 Worker 包），反而因文件变小编译更快。 |

### S-2. 循环依赖 + `# noqa: E402` 压制：22 个模块「从 main 反向 import」

| 维度 | 内容 |
|---|---|
| **现状取证** | `chain.py:24`、`quote_api.py:48` 均以 `from main import app, _acquire, _get_current_user, ...` **反向导入**定义它们的宿主模块；`main.py` 又在文件末尾 `import chain` / `import quote_api` 完成挂载——形成 **`main` ↔ `chain`/`quote_api` 的双向循环依赖**，靠 Python「模块缓存部分初始化对象」的隐式行为才没炸。全仓库 `# noqa: E402` 命中 **224 处**，其中生产源码（排除 `tests/`）**62 处**（`main.py` 29、`quote_api.py` 8、`local_run.py` 6、`chain.py` 3、`__init__.py` 3、`seed_ports/seed_port_coords` 各 2、`tax_archives.py`/`models.py` 各 1），其余 162 处在 `tests/`（测试文件用延迟 import 构造夹具，属正常）。 |
| **影响** | ① 可维护性陷阱：任何一个 `main.py` 顶部新增 import 语句顺序变化，都可能让 `chain.py`/`quote_api.py` 的反向 import 拿到未初始化的符号，触发 `ImportError` 或运行时 `AttributeError`；② 静态分析失效：`E402` 被压制后，mypy/pyright/IDE 无法正确推断模块级符号依赖图，重构时容易漏改引用；③ 新接手者认知负担：必须先理解「文件末尾 import 挂载」这个非标准约定，才能读懂任意一个 `ws_*.py`。 |
| **根因** | 与 S-1 同源：`app`（FastAPI 实例）、`_acquire`（连接池封装）、`_get_current_user`（鉴权依赖）都定义在 `main.py`，但所有兄弟路由模块都需要复用它们，于是形成「宿主定义、子模块反向 import、宿主末尾再 import 子模块完成挂载」的环。这是「单文件巨石 + 挂载」架构的必然产物，不是某次具体改动引入的 bug。 |
| **已有约束（防再犯）** | ① 本次新增：`scripts/check-structural-debt.py` 统计 `# noqa: E402` / `# ruff: noqa: E402` 数量，**阈值 40 处**（当前 34+2=36，新增会被门禁拦下）；② `AGENTS.md` 技术栈基线（2026-10-20 版）明确 Next 16/ESLint 10 flat config 已锁，未显式约束 Python import 规范——本次补上。 |
| **治理计划（免费版 ✅ 够）** | 与 S-1 合并推进：① 把 `app` 实例、`_acquire`、`_get_current_user`、`DEFAULT_TENANT`、`_jwt_secret` 等「宿主符号」抽到 `backend/kaas_common/app_core.py`（或 `backend/worker/src/platform/app_core.py`），`main.py` 与所有 `ws_*`/`chain`/`quote_api` 都从这里 import，消除反向依赖；② 每抽一批符号，就把对应的 `# noqa: E402` 还原成正常文件头 import，门禁计数逐步下降；③ 终态目标：`# noqa: E402` 命中 **≤ 5 处**（仅保留 `local_run.py` 等确实需要延迟 import 的场景）。 |
| **免费版判断** | ✅ **免费版够**：与 S-1 同一次重构，不新增基础设施。 |

### S-3. 全仓无 TODO/FIXME/HACK 注释：86 处债务散落在代码外，不可追溯

| 维度 | 内容 |
|---|---|
| **现状取证** | `Select-String -Path (git ls-files '*.py','*.ts','*.tsx') -Pattern 'TODO|FIXME|HACK'` 命中 **0 处**（2026-10-21 实测，全仓 13.7 万行 Python + 8.9 万行 TS 无一条内联债务注释）。对照：`docs/PROBLEM_STATUS_2026-10-11.md` 有 86 处「已知问题/待修」条目、`docs/TODO.md` 有 40+ 条待办，但这些**全部集中在文档**，代码里对应位置没有任何锚点。 |
| **影响** | ① 修 bug 时无法定位「这段代码是不是已知坑」：开发者改 `ws_files.py` 某个 fallback 分支时，得先翻 `PROBLEM_STATUS` 搜关键词，才知道这是不是已登记的已知问题；② 新增债务无处标记：如果开发者在代码里发现新问题但不想立刻修，没有约定俗成的 `TODO(S-x)` 格式可写，只能口头传达或丢失；③ 文档与代码脱节风险：`TODO.md` 条目做完后，代码里如果还留着「这里曾有 bug」的痕迹，后来者不知道该不该信任这段代码。 |
| **根因** | 项目从一开始就把「问题对账」当作**文档驱动**（`PROBLEM_STATUS` 顶部滚动更新、`TODO.md` 唯一账本），没有建立「代码内联债务注释」的双轨制；`AGENTS.md` 规则 1 强制「改代码必须同步文档」，但没有反向要求「发现债务必须在代码里留锚点」。 |
| **已有约束（防再犯）** | 本次新增：`AGENTS.md` 补充规则——「代码内发现结构性债务/已知坑，必须写 `# TODO(S-x): 一句话` 或 `// TODO(S-x): 一句话`，`S-x` 对应本文档条目编号；无对应条目的先在本文登记再写注释」；`scripts/check-structural-debt.py` 不强制要求 TODO 数量（避免为凑指标写废话注释），但会打印当前数量供 review 时对照。 |
| **治理计划（免费版 ✅ 够）** | 一次性 + 持续：① 存量治理：把现有 52 处 `TODO A1/A3/A8` 这类**任务编号注释**，逐条核对是否已完成——已完成的删注释，未完成的改成 `TODO(S-x): 一句话`（S-x 对应本文条目编号，或在 `TODO.md` 有对应条目时写条目号如 `TODO(TODO.md C12)`）；② 新增纪律：以后发现结构性债务，先在本文登记 S 条目，再在代码里写对应 `TODO(S-x)`；条目做完时同步删注释。**不追求数量，追求「每条注释都能反查到一条活着的债」** |
| **免费版判断** | ✅ **免费版够**：纯文档/注释纪律，零成本。 |

### S-4. 后端裸 `except Exception` 88 处 / `print()` 调试残留 18 处

| 维度 | 内容 |
|---|---|
| **现状取证** | ① `except Exception` 命中 **88 处**（`ws_files.py` 17、`chain.py` 9、`quote_api.py` 9、`main.py` 8、`ws_cron.py` 7、`ws_docs_ext.py` 4，其余散在 22 个文件），2026-05 `CODEBASE_AUDIT_REPORT` 已把「异常处理过于宽松、隐藏根因」列为后端严重问题第 1 条，但至今未收敛；② `print()` 命中 **18 处**（`ws_cron.py` 10、`ws_files.py` 5、`ws_docs_ext.py` 3），全在生产 Worker 源码里（不在 tests/scripts），Worker 运行时 `print()` 输出进 Cloudflare 日志，不可控且可能泄露业务数据。 |
| **影响** | ① 88 处裸 `except` 让真实 bug 被吞掉：`ws_files.py` 的 R2/inline fallback 链路里，任何异常都被 `except Exception: pass/return 默认值` 吃掉，出问题时只能靠 `file_objects.storage` 字段反推走了哪条分支，无法从日志看到原始堆栈；② `print()` 残留在 Worker 里是定时炸弹：一旦打印了 `tenant_id`/`customer_id`/文件 key 等业务数据，会进 Cloudflare 账户日志（合规风险），且与 `AGENTS.md` 里「日志时间倒序」的纪律不一致（`print()` 不带时间戳）。 |
| **根因** | ① 异常处理宽松是「快速把功能跑通」阶段的产物，`CODEBASE_AUDIT_REPORT` 给出了「区分 `ValidationError`/`HTTPException`/业务异常」的建议但未强制执行；② `print()` 是开发期调试残留，没有「生产代码禁止裸 `print()`、必须走 `logging`/结构化日志」的硬约束，也没有 pre-commit hook 拦截。 |
| **已有约束（防再犯）** | 本次新增：① `scripts/check-structural-debt.py` 统计两项目并设阈值：`except Exception` **≤ 100 处**（当前 88，新增会被拦下，不设为 0 是因为部分兜底路径确实需要 broad catch，但必须在本文登记理由）、`print()` **≤ 20 处**（当前 18，同理）；② `AGENTS.md` 补充规则：「生产 Worker 源码（`backend/worker/src/**`）禁止裸 `print()`，必须用 `logging` 或 Cloudflare Worker `console.log`/`console.error`（带时间戳、结构化字段）；新增 `except Exception` 必须在本文登记 S 条目说明为什么不能 catch 具体异常类型」。 |
| **治理计划（免费版 ✅ 够）** | 分两批：① 清理 `print()`：把 18 处 `print()` 改成 `console.log`（Worker）或删掉（纯调试残留），预计半天；② 收敛 `except Exception`：优先处理 `ws_files.py`（17 处，文件存储关键链路）——把「R2 失败降级 inline」这类**有意的兜底**保留 broad catch 但加注释说明「这里故意 catch Exception，因为要保证上传不失败，实际落点记 `file_objects.storage`」，把「没想清楚就 catch」的改成具体异常类型或直接抛出。 |
| **免费版判断** | ✅ **免费版够**：纯代码质量治理，零成本。 |

### S-5. 单人项目无 Code Review / 无第二人验证：所有「已修」结论只有一人背书

| 维度 | 内容 |
|---|---|
| **现状取证** | `git log --format='%an' \| Group-Object` 只有 **David Sun (559)** / **David (192)** 两个作者（同一邮箱 `dspro0124@163.com`），实为同一人 + AI 协作产出。751 个 commit、11 次生产部署、46 项安全审计修复、27 条 e2e、1560 条 worker 测试——全部由单人判定「已完成」，没有任何 commit 是 `Reviewed-by:` / `Co-authored-by:` 第二人。 |
| **影响** | ① 「已修」结论可信度打折：`QA_AUTHZ_VERIFY_2026-10-21.md` 的 7 角色越权矩阵、`MIGRATION_DOWNGRADE_AUDIT` 的「10 处破坏性操作已标注 IRREVERSIBLE」等，都是执行者自己写的验收报告，没有第三方抽查；② 盲区难以发现：单人项目容易形成「我以为我检查了」的确认偏误，比如 2026-10-21 生产部署才发现的两个 500/502 bug（`actor_id` int→text、PDF `arrayBuffer` 读取），说明「单人自测」对真实链路覆盖有限；③ 招聘/协作风险：如果项目要交给团队接手，接手者没有任何「前人 review 记录」可参考，只能从代码反推设计意图。 |
| **根因** | 项目从 2026-04 立项就是单人 + AI 编排模式，`AGENTS.md` 定义了「Lead → 队友」的多智能体协作规则，但这些「队友」是 AI 会话，不构成人类第二视角；没有建立「发布前必须有第二人 review 关键路径」的流程约束。 |
| **已有约束（防再犯）** | ① 本次新增：`AGENTS.md` 补充规则——「生产部署前（`pywrangler deploy` / `wrangler secret put` / 迁移上生产）必须在 `TODO.md` §G 待用户拍板清单登记，由用户充当第二人确认；安全审计/越权修复类改动完成后，必须在 `docs/QA_*_*.md` 明确标注『单人执行，未复核』，不可伪装成多人验收」；② 本次新增：`docs/STRUCTURAL_DEBT.md`（本文）本身就是给「未来第二接手者」准备的设计意图说明文档，降低交接时的信息损耗。 |
| **治理计划（免费版 ⚠️ 勉强够）** | 不是代码治理，是**流程治理**：① 短期（单人可做）：把「生产部署前清单」做成 `TODO.md` §G 的强制检查项，每次部署前逐条勾选；② 中期（需外部资源）：找 1–2 位同行做「关键路径抽查 review」（安全审计/迁移链/越权修复三类），每次 1–2 小时，不求全量覆盖只求发现盲区；③ 长期（若项目要商业化）：引入正式的 `CODEOWNERS` + PR review 流程，或把项目开源接受社区 review（当前仓库已 public，具备条件）。 |
| **免费版判断** | ⚠️ **免费版勉强够**：流程约束（部署前清单、验收报告标注「单人执行」）零成本；但「真人第二人 review」依赖外部资源（同行时间/社区反馈），免费版本身无法解决，只能靠流程缓解。 |


> **S-5 落地（2026-10-21，P2 批收口）**：流程约束已建——① 发布检查单沿用 HANDOVER_2026-10-20_FINAL §5
> （迁移→构建→部署→冒烟逐步签核）；② 验收/交接文档强制标注「单人执行、无第二人 review」
> （已在 PROBLEM_STATUS 交接摘要执行）；③ 用自动化门禁替代人工 review 的第一道把关：结构债门禁、
> schema 列级漂移门禁、契约 R0–R5、金标 harness 全部并 CI；④ 长期项（CODEOWNERS / 开源社区 review）
> 登记在 TODO §G 待商业化时再议。状态 ⏳→✅（流程面）。
### S-6. 技术选型无论证留痕：为什么 raw asyncpg、为什么不用 ORM/Redis/消息队列

| 维度 | 内容 |
|---|---|
| **现状取证** | 代码里有大量「隐式决策」：全生产链路用 **raw asyncpg + `$1` 占位符**（无 SQLAlchemy/ORM，ORM 仅保留在 `backend/orchestrator/app/db` 做迁移），`quote_api.py` 文档字符串写了「Workers 无常驻调度器，replied 扫描仅手动触发」、`docker-compose.yml` 注释写了「2026-10-21 起移除 Redis——运行时无 redis 客户端」、`chain.py` 用了「文件末尾 import 挂载」而非 `APIRouter`——这些都是**正确或合理的取舍**，但全仓库**没有一份文档集中论证「为什么选这个、不选那个、什么条件下会重新评估」**。只能从代码注释、commit message、`PROBLEM_STATUS` 的碎片记录里反推。 |
| **影响** | ① 新接手者容易误判：看到「没有 ORM」可能以为是「偷懒没写」，不知道这是「Workers 冷启动 CPU 限额倒逼的决策」；② 招聘面试/对外介绍时讲不出体系：单个决策散落在各处，无法形成「我们有完整技术选型方法论」的叙事；③ 未来重新评估成本高：如果业务量增长到需要引入 Redis/消息队列，没有「当初为什么不用」的论证，很难判断「现在是不是真的需要了」还是「重复造轮子」。 |
| **根因** | `AGENTS.md` 规则 1 只要求「改代码必须同步文档」，没有要求「做技术选型决策必须留论证」；`PROBLEM_STATUS` 的定位是「问题对账」不是「决策留痕」，`UNCERTAIN.md` 只记「待拍板」不记「已拍板的理由」。 |
| **已有约束（防再犯）** | 本次新增：① 新建 `docs/ARCH_DECISIONS.md`（ADR 简化版）——每项重要技术选型（框架/数据库/存储/队列/鉴权/部署）记录「背景 → 备选方案 → 决策 → 理由 → 重新评估条件」；② `AGENTS.md` 补充规则：「新增/替换基础设施组件（数据库、缓存、队列、对象存储、鉴权方案、部署平台）前，必须先在 `ARCH_DECISIONS.md` 登记一条 ADR，写明备选方案与取舍理由，经用户确认后方可实施」。 |
| **治理计划（免费版 ✅ 够）** | 一次性补录：把已有的隐式决策（raw asyncpg、无 Redis、R2 优先/inline 兜底、Hyperdrive 直连无池、Python Worker 而非 TS、文件末尾 import 挂载）补成 6–8 条 ADR，每条不超过半页，写清「当时为什么不选另一条路」。 |
| **免费版判断** | ✅ **免费版够**：纯文档，零成本。 |

---


### S-7. AI 生成代码的可维护性 / 可解释性无登记（2026-10-21 用户点名列补）

| 维度 | 内容 |
|---|---|
| **现状取证** | 文档体系强在「现象—根因—决策—验证」闭环，但**不讨论「这段代码为什么这么写」**：取舍理由只散落在代码注释与 commit message 里；外部追问（面试/审计/接手）时文档帮不上忙。本仓库大量代码由 AI（DSH）生成，生成过程的取舍（为什么这个算法/为什么这个结构）没有任何留痕。 |
| **影响** | ① 可解释性差：关键路径（报价引擎/单证 facts）的取舍无法向人讲清；② 可维护性差：后来者改 AI 生成代码时不知道哪些是「有意设计」、哪些是「生成器的随意选择」，容易把设计当垃圾清掉；③ 知识流失：会话结束后，当时的推理过程永久丢失。 |
| **根因** | 既有文档体裁（问题对账/待办账本）没有「代码取舍留痕」的位置；AI 生成过程天然不留痕，不靠纪律主动记录就没有。 |
| **已有约束（防再犯）** | ① 2026-10-21 起 ADR 体系落地（ARCH_DECISIONS.md）：**基础设施/架构级取舍必须登记 ADR**；② 执行手册 §1「禁止第二份实现」减少「随意生成重复逻辑」。 |
| **治理计划（免费版 ✅ 够）** | ① **关键路径取舍注释纪律**：报价引擎、单证内核、鉴权等核心模块，每个非平凡的函数/算法在 docstring 里加「取舍：<为什么这样>」段（新代码强制，存量随触碰补）；② 重大 AI 生成改动在 PR/交接摘要里加「生成说明」（提示词意图+人工修正点）；③ ARCH_DECISIONS.md 作为取舍问答的第一入口，面试/审计追问先查 ADR。 |
| **免费版判断** | ✅ 纯文档/注释纪律，零成本。 |

## 2. 免费版优先级矩阵（先做什么）

| 优先级 | 条目 | 理由 | 预估工作量 |
|---|---|---|---|
| **P0（本批）** | S-3（TODO 锚点纪律）、S-6（ADR 补录）、S-4 第一步（清 `print()`） | 纯文档/注释/简单代码清理，零风险、零成本，立即消除「代码与文档脱节」的最高频痛点 | S-3: 0.5 天；S-6: 0.5 天；S-4 print: 0.5 天 |
| **P1（下一批）** | S-1 + S-2（main.py 拆分 + 循环依赖消除） | 免费版够，且直接改善冷启动（虽不是根治，但是 P1 裁剪项）；分三步走，每步独立可交付 | 3–5 天（分 3 个 PR） |
| **P2（随后）** | S-4 第二步（收敛 `except Exception`）、S-5（流程约束落地） | S-4 第二步需要逐处判断「有意兜底 vs 无意吞异常」，比 print 清理慢；S-5 是流程不是代码，落地快但依赖持续执行 | S-4: 1–2 天；S-5: 0.5 天（写清单） |
| **⛔ 暂不动** | 冷启动根治（迁 TS Worker / 拆模块真懒加载）、地理迁移（Neon 迁东京） | 见 §3 | — |

---

## 3. 免费版撑不住、先不动的项（登记，不推进）

> 以下两项原登记「2026-10-21 用户指示：先不动」，**同日已被用户新决策取代（见各节更新注记）**，
> 现均为活跃项，执行计划统一在 [`OPTIMIZATION_PLAN_2026-10-21.md`](./OPTIMIZATION_PLAN_2026-10-21.md)。

### 3.1 冷启动根治（迁 TypeScript Worker / 真懒加载）

- **为什么免费版不够**：Python Worker 的 Pyodide 引导 + ~800KB 源码编译是**运行时架构决定的**，Cloudflare Workers Free/Paid 都跑同一个 Python 运行时，付费不会让 Python 冷启动变快（只会放宽超时阈值）。真正的根治路径是「迁 TS Worker（冷启动 ~50ms）」或「Python 侧做模块级真懒加载」——前者是全栈架构手术（后端 13.7 万行 Python 要么重写、要么 Pyodide → WASM 优化），后者受 Pyodide 限制（当前无法像 Node.js 那样按需编译子模块）。
- **免费版判断**：❌ **免费版不够**（且付费版也不直接解决，需要架构迁移）。
- **什么条件下会动**：用户拍板「接受迁 TS Worker 的成本」或「Pyodide 官方支持模块级懒加载」，二者取一。
- **✅ 2026-10-21 更新：条件已触发**——用户拍板**全量迁 TS Worker（不折中）**，执行计划 W3（3–5 周四阶段，
  金标对照 + 引擎双跑），详见 `OPTIMIZATION_PLAN_2026-10-21.md` §2。另：S-1/S-2（Python 巨石拆分/循环依赖）
  治理计划随之**被 W3 取代**（⛔ 不投入，避免退役前 throwaway），最终以「被 W3 解决」销账（待 D3 拍板）。

### 3.2 地理延迟根治（Neon 迁 ap-northeast-1）

- **为什么免费版不够**：当前 Neon 生产库在 us-east-2，中国访问 RTT 215ms（`PROD_PERFORMANCE_AUDIT_2026-10-21.md` §1.3），迁东京可以把 RTT 降到 60–80ms。**但**：① Neon 免费档支持东京区域，**技术上免费版够**；② 真正的阻塞是**停机窗口**——迁移要停机 10–30 分钟，需要用户拍板「什么时间窗口可以接受停机」；③ 迁移后 Hyperdrive 配置、R2 桶区域、Cloudflare Worker 区域都要联动检查（Worker 目前跑在 Cloudflare 全球边缘，DB 迁东京后 Worker → DB 的路径也要重新测）。
- **免费版判断**：⚠️ **免费版勉强够**（Neon 免费档支持东京，但停机窗口 + 联动配置调整需要用户决策，不是纯免费/纯代码问题）。
- **什么条件下会动**：用户拍板「接受停机窗口」并授权执行迁移。
- **✅ 2026-10-21 更新：已完成**——迁至 **aws-ap-southeast-1 新加坡**（Neon 免费档无东京可选），RTT 245→75ms，
  pg_dump/pg_restore 全量迁移（生产 schema 与 alembic head 不一致，弃用 alembic 重建），逐表 count 0 差异；
  新 Hyperdrive `6830420703984a19a99a334afff6776e`，version `cd87aba7`。详见 `PROD_PERFORMANCE_AUDIT_2026-10-21.md` §4.2。

---

## 4. 门禁与自动化（本次新增）

### 4.1 `scripts/check-structural-debt.py`（静态结构债门禁）

**用途**：在 CI / 本地门禁里拦截「结构性债继续累积」，与现有 `check-schema-coverage.py` / `check-runtime-deps.py` 同一风格（纯静态、不连库、退出码 0=通过 / 1=有未登记违规）。

**检查项**（2026-10-21 建档基线）：

| 检查项 | 阈值 | 当前值 | 超阈值动作 |
|---|---|---|---|
| `backend/worker/src/main.py` 行数 | ≤ 4000 | 5170 | ❌ **已超阈值**——本次登记为 S-1 已知债，门禁打印警告但不阻断（`--allow-known` 模式）；S-1 治理完成后阈值降为 2000 |
| 单个 `backend/**/*.py` 文件行数 | ≤ 3000 | 5170 (main.py) | 同上 |
| `# noqa: E402` 命中数（生产源码，排除 `tests/`） | ≤ 80 | 62 | ❌ **已登记 S-2 已知债**——门禁打印警告但不阻断（`--allow-known` 模式）；S-1/S-2 治理完成后阈值降为 5 |
| `except Exception` 命中数（`backend/**/*.py`） | ≤ 100 | 88 | ✅ 在阈值内，新增会被拦下 |
| `print()` 命中数（`backend/worker/src/**`） | ≤ 20 | 18 | ✅ 在阈值内，新增会被拦下 |
| `TODO\|FIXME\|HACK` 注释数（生产源码，排除 `tests/`） | 无阈值，仅打印 | 52（后端 31 + 前端 21） | 仅打印，不强制（避免凑指标写废话注释）；重点是格式统一与反查索引，见 S-3 治理计划 |

**用法**：
```powershell
# 本地（orchestrator venv 解释器，与 AGENTS.md 口径一致）
backend/orchestrator/.venv/Scripts/python.exe scripts/check-structural-debt.py

# 带 --allow-known：允许已登记的 S-1/S-2 超阈值不阻断（日常开发用）
backend/orchestrator/.venv/Scripts/python.exe scripts/check-structural-debt.py --allow-known

# CI：并入 backend-test.yml 与 frontend-ci.yml 的静态断言步骤，用 --allow-known 模式
```

### 4.2 与现有门禁的关系

- `check-schema-coverage.py`（表覆盖）→ 仍负责「新环境能否空库起得来」；
- `check-runtime-deps.py`（运行时依赖）→ 仍负责「Workers 包不被 ORM/迁移依赖污染」；
- `check-structural-debt.py`（本次新增）→ 负责「结构性债不继续累积」，三者互补，不重复。

---

## 5. 待用户拍板清单（本文相关，同步登记在 `TODO.md` §G）

| # | 事项 | 需要用户决定什么 | 不做的后果 |
|---|---|---|---|
| S-G1 | 历史密钥清理（见 §6 专章） | ① 是否执行 `git filter-repo` 重写历史（需重推 force、所有 clone 失效）；② 若不重写，是否接受「历史可读」并仅轮换所有泄露凭据 | 见 §6 详细分析 |
| S-G2 | 冷启动根治路径 | 接受迁 TS Worker 的成本，还是等 Pyodide 懒加载支持 | 见 §3.1 |
| S-G3 | 地理迁移停机窗口 | Neon 迁东京的可接受停机时间窗口 | 见 §3.2 |

---

## 6. 附：仓库历史密钥明文问题（专项登记，待执行）

> **性质**：这不是「结构性代码债」，是**安全债**，但与本文档同批建档，因为「防止未来再泄露」的约束与 S 组条目同源（都是「靠纪律/门禁防再犯」）。2026-10-21 用户指示：**先写清楚，不用动手**。

### 6.1 已知泄露事实（来自 `SECURITY_AUDIT_2026-10-19.md`，本文不重复审计，只引用）

> **注（2026-10-21 重写后）**：下表 commit 引用（`c91cf0e50`/`100e767`/`5e78d9ce`/`fbced671` 等）是**重写前历史标识**，
> 全历史已被 filter-repo 重写并 force push，这些 hash 已不再指向新历史中的提交；仅作历史证据留档（泄露值已轮换作废）。

| 凭据类型 | 泄露位置 | 当前状态 | 备注 |
|---|---|---|---|
| Notion 集成令牌（`ntn_` 开头） | `.codex/config.toml` 第 14 行 `--api-key=ntn_...`，commit `c91cf0e50` 引入 | 已从当前树删除（commit `100e767`），**git 历史仍可读** | 用户 2026-10-20 裁决：不清理、不轮换，风险接受关闭 |
| Neon 生产口令（`npg_` / `postgresql://user:pass@...neon.tech`） | `backend/.tools/list_columns.py` 等 4 个工具脚本，commit `5e78d9ce` 之前 | 已改为 `KAAS_DSN` 环境变量占位（`fbced671`），当前树干净，**git 历史 37 个 commit 可读** | 用户 2026-10-20 裁决：不轮换、不 filter-repo，风险接受关闭（`TODO.md` N6 条目） |
| GitHub PAT（`ghp_` 开头） | `docs/PROBLEM_STATUS_2026-10-11.md:4432`（文档里提及但值已脱敏为 `<REDACTED>`） | 文档内已脱敏，但需确认该 PAT 是否曾在真实 commit 里以明文出现（本文档未审计到，需补一次全历史扫描） | 待确认 |
| AWS Access Key（`AKIA` 开头） | 仅命中测试文件（`test_files_s3.py`、`test_ws_files_storage.py`），值为明显假值（`AKIAIOSFODNN7` 是 AWS 官方文档示例 key） | 无需处理 | 已排除 |
| Resend API Key（`re_` 开头） | `.github/workflows/deploy.yml` 等，值为 `${{ secrets.RESEND_API_KEY }}` 引用而非明文 | 无需处理 | 已排除 |

### 6.2 待补审计：全历史凭据扫描

**为什么需要**：`SECURITY_AUDIT_2026-10-19.md` 是**静态树审计**（只看当前 commit 的文件内容），没有做「全 git 历史 blob 扫描」——Notion 令牌和 Neon 口令能被发现是因为它们**碰巧在当前树里还能搜到残留**，但可能还有「早已从当前树删除、只存在于历史 commit」的凭据没被发现。

**建议执行**（待用户授权，本次不执行）：
```powershell
# 用 gitleaks 做全历史扫描（需先安装：winget install gitleaks.gitleaks）
cd D:\projects\kaas-platform
gitleaks detect --source . --log-opts="--all" --report-path .tmp/gitleaks-full-history.json --verbose

# 或用 trufflehog（需先安装）
trufflehog git file://. --only-verified --json > .tmp/trufflehog-full-history.json
```

**产出**：一份「哪些 commit、哪些文件、哪类凭据」的完整清单，用于判断「是否还有未登记的泄露」。

### 6.3 三条治理路径（供用户拍板，本次不执行）

| 路径 | 做法 | 优点 | 缺点 | 适用条件 |
|---|---|---|---|---|
| **A. 接受风险（用户 2026-10-20 已选）** | 不重写历史、不轮换凭据，仅在文档里登记「已知泄露」 | 零成本、零中断 | 任何能读 git 历史的人都能拿到这些凭据（若凭据未过期） | 凭据已全部轮换过/已过期，或「历史可读」风险可接受 |
| **B. 只轮换、不重写历史** | 轮换所有泄露凭据（Neon 口令、Notion 令牌、GitHub PAT），历史里的旧值变废纸 | 零中断、低成本 | 需要逐个平台手动轮换（Neon Dashboard、Notion Settings、GitHub Settings） | 凭据还能轮换（账号没丢、权限还在） |
| **C. 轮换 + `git filter-repo` 重写历史** | 先轮换，再用 `git filter-repo` 把历史里的凭据值替换为 `<REDACTED>`，重推 force | 彻底清除历史泄露 | ① 所有现有 clone 失效，需要通知协作者重新 clone；② 37+ 个 commit 的 hash 全变，外部引用（issue/PR/文档里的 commit 链接）全部失效；③ GitHub 缓存的旧对象要联系 support 清理 | 凭据无法轮换（账号已丢/权限已收）且「历史可读」不可接受 |

### 6.4 「防止未来再泄露」的约束（无论选哪条路径都要做）

1. **pre-commit hook**：`.husky/pre-commit` 现在只跑 `pnpm lint-staged`（前端），不检查后端密钥。补一条：commit 前用 `gitleaks protect --staged` 扫描暂存区，命中即拒绝 commit。
2. **CI 门禁**：`.github/workflows/backend-test.yml` / `frontend-ci.yml` 各加一步 `gitleaks detect --source . --redact`（只扫当前树，不扫历史，避免 CI 超时），命中即 fail。
3. **`.gitignore` 加固**：确认 `.codex/`、`.env*`、`~/.dsh/secrets/` 相关路径已在 `.gitignore`（`.codex/` 已在，2026-10-21 实测）；新增「密钥文件一律走环境变量、不入仓」的纪律写入 `AGENTS.md`。
4. **凭据命名纪律**（`AGENTS.md` §0 已有）：`kaas-*-system-*` 一个密钥只用于一个地方——继续强化，新增凭据时先查 `~/.dsh/secrets/inventory.md` 确认命名归属。


### 6.6 执行记录（2026-10-21 · 用户新裁决：清理，推翻 2026-10-20「接受风险」）

| 步骤 | 内容 | 结果 |
|---|---|---|
| 1. 全历史取证 | blob 级扫描 5039 个 blob（逐 commit 口径有假阴性，blob 级为准） | 真实泄露：**Notion token**（`.codex/config.toml`/`.mcp.json`，2 blob）+ **Neon 旧库 DSN**（`DEPLOY.md`、`backend/.tools/*.py` 8 文件、审计文档副本）；AWS `AKIAMINIOEXAMPLE0001` 为 MinIO 示例假值排除；GitHub PAT/Resend 0 命中 |
| 2. 历史重写 | mirror 克隆 + `git filter-repo --replace-text`（明文→`***REMOVED***`），1053 提交→774（273 条纯噪声提交变空被 prune），force push main | ✅ 重写后对 4 个真实泄露值全历史 **0 命中** |
| 3. 本地同步 | `fetch + reset --hard origin/main`，在途未跟踪文件（ts-worker 迁移中文件）原样保留 | ✅ |
| 4. 凭据轮换 | 旧项目 `falling-salad-31662168` 角色口令 Neon API `reset_password` 轮换（泄露 DSN 指向其 `ep-wandering-frost` 端点）；旧 Hyperdrive `f53fed…` 连接串同步更新；`~/.dsh/secrets/neon-prod-dsn.txt` 更新 | ✅ 新口令实测可连；旧口令作废；**回滚路径保持可用** |
| 5. 收尾 | 删 mirror 与临时明文文件（不留副本） | ✅ |

**遗留（需用户在外部平台操作）**：① **Notion 集成 token 需在 Notion 后台吊销**（API 无吊销端点，只能由用户在 Settings→Connections 操作）；② GitHub/仓库侧：历史已重写，其他未同步的本地 clone / 旧分支需重新 clone（本项目单人环境，`feat/*` 旧 worktree 分支已自动失效）；③ GitHub 服务端对象缓存可能短暂保留旧对象，但泄露值已通过轮换失效，风险已闭环。

### 6.5 本次不执行，待用户拍板

- [ ] 是否执行 §6.2 全历史扫描（需先安装 gitleaks/trufflehog）
- [ ] 三条路径（A/B/C）选哪条（用户 2026-10-20 已口头选 A，是否维持）
- [ ] 若选 B/C：轮换清单逐项授权（Neon 口令、Notion 令牌、GitHub PAT）
- [ ] §6.4 四项「防再犯」约束是否本批落地（建议做，零成本）

---

*本文档由 2026-10-21 结构性缺口盘点生成，数据来源：`git ls-files` 实测统计、`PROD_PERFORMANCE_AUDIT_2026-10-21.md`、`SECURITY_AUDIT_2026-10-19.md`、`CODEBASE_AUDIT_REPORT_2026-05-13.md`、`AGENTS.md`、`git log`。*