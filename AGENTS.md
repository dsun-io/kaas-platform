# KaaS 平台 · 项目规则（每次会话自动生效）

> 这些是**用户明确下达的全局规则**。放在仓库根而不是只留在对话里，
> 是为了让**每一次新会话自动遵守**，不依赖"上次那位记得"。

## 1. 项目更新 = 代码 + 文档 + 推送（缺一不可）

**用户原话（2026-10-11）**：

> 项目更新一定要更新相关文档以及将最新代码提交到远程

具体含义：

- **改代码必须同步更新相关文档**。当前口径文档是
  `docs/PROBLEM_STATUS_2026-10-11.md`；**每完成一项就更新它**，
  并在其顶部「交接摘要」里同步进度。
  - 文档里过时的状态**必须改掉**。宁可标注"未做"，也不能让文档写着旧状态
    ——后来者会按它判断。本项目已多次出现"代码做了、文档还标着 ❌"。
- **必须提交并推送到远程**（`main`）。本地有未推提交时，**先补推再收尾**。
  推送偶发 `Connection was reset` / `Failed to connect`，**要重试**。

## 2. 需要用户确认的，必须弹窗

**用户原话（2026-10-11）**：

> 全局rules：需要我确认的必须弹窗

- 用 `ask_user_question` 提出，**不要用纯文本问**。
- 一次把相关选项给全（含推荐项与代价），不要挤牙膏式地反复问。

## 3. 不确定的不要擅自动手

**用户原话（2026-10-11）**：

> 不确定的不要擅自动手

- 涉及**授权策略、数据删除、生产环境、跨大版本升级**等，先取证再定，
  需要用户拍板的走规则 2。
- 但要**区分两类不确定**：
  - **策略不确定**（谁能发起、粒度选哪层）→ 弹窗问；
  - **事实不确定**（这段代码还有人用吗、表里有没有数据）→ **自己去查证**，
    不要把"我没查"包装成"需要你定"。本项目在这方面已栽过：曾把
    「我没搭起来测试环境」写成「这段代码根本测不了」，也差点把
    「有活页面的区域」当成死代码清掉。

## 其它需要知道的口径

- **租户 ≠ 团队**：`tenant_id` 恒为 `"default"`，**团队（`team_id`）才是隔离边界**。
- **共享内核**：两端共用的逻辑放 `backend/kaas_common/`，
  改完必须跑 `pwsh scripts/sync-shared.ps1`，否则 worker 端是旧的。
- **门禁**（改完都要跑）：orchestrator `pytest -m unit`、worker `pytest`、
  前端 `typecheck` / `lint` / `test`、`contracts:check`、
  `python scripts/route-parity.py`、`sync-shared.ps1 -Check`、
  `NEXT_EXPORT=1 pnpm build`。

### ⚠️ 改 Pydantic 模型 / 路由时：`contracts:check` 的"绿"可能是**假绿**

**实测（2026-10-12，R6 上线当天就被踩到）**：

- **提交前**跑 `contracts:check` ⇒ **PASS**；**提交之后**再跑 ⇒ **FAIL** `R6.schema:<模型> 期望形状过时` ✗
- 原因：**R6 两侧（源码与产物）都取 HEAD 快照** ⇒ 它比的是"HEAD 源码 ↔ **已提交**的
  `backend/orchestrator/docs/openapi.json`"，**看不到工作树里未提交的改动** ⇒
  **产物在你提交的那一刻就旧了**。

**正确顺序（缺一步就会留下 main 上的红）**：

```
改模型/路由  →  重生成产物  →  提交  →  【再跑一次】contracts:check
```

重生成命令（**必须带 `PYTHONPATH`**，否则 `ModuleNotFoundError: No module named 'app'`）：

```bash
cd backend/orchestrator
PYTHONPATH=. .venv/Scripts/python scripts/export_openapi.py
```

> 这是**设计使然**（R6 刻意不读工作树，以免把别人未提交的半成品当基准 ✗），
> 不是门禁失灵；所以**顺序必须反过来**：先提交产物，再让门禁看它。
- 环境无 `pnpm`/`npm` 可直接调用，用
  `C:\Users\HJ\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`
  + `...\pnpm\bin\pnpm.mjs`。跑 `.ps1` 前先
  `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force`。

## 4. 这个工作区可能**同时有多个任务在写** —— 提交纪律

2026-10-11 实测：同一工作区里**多条线并行**（不同的 DSH 会话 / 队友），
`git status` 里随时有**别人的未提交改动**。

- **`git commit -- <pathspec>` 不足以保证"没提交别人的东西"** ✗
  它记录的是**工作树内容**，不是 index ⇒ **同一个文件里别人的未提交 hunk 会被一起提交**。
  （实测：`backend/worker/src/main.py` 里两拨人的 hunk 混在一起，且别人的 hunk 依赖一个
  **未跟踪**文件 ⇒ 那提交必然 ImportError / CI 红。）
  ⇒ 改用**私有 `GIT_INDEX_FILE`**（指向 `%TEMP%`）只装自己的 hunk，**不碰共享 index、不碰他人工作树**。
- **提交前自检**：`git diff --cached --stat` 只应出现自己的文件；
  `git diff --cached -- <file>` 只应含自己的 hunk。
- **提交后自检**：`git status --short` 里**别人的改动必须原样还在**。
- **部分 hunk 提交要先转 LF**：本仓库工作树是 **CRLF**、index blob 是 **LF**
  ⇒ `git diff` 出的补丁含 CR ⇒ 对 LF 的 index blob 直接 `patch does not apply`
  （实测 130 个 CR）⇒ 转 LF-only 后 `git apply --cached --check` 通过。
- **不要拿别人的文件做自证**（例如为了演示门禁能抓到而临时改错一个键）：
  **一律只在自己的写入范围内做**；确实需要跨范围，**先问**。
  实测发生过一次"险过"——临时改的文件正被别人并发编辑。
- **不要用 `git add -A` / `git add .` / 裸 `git commit`**。本项目已因此**断过一次 HEAD**。

#### 用私有 `GIT_INDEX_FILE` 提交后，**必须**把自己涉及的路径在共享 index 里归位

**实测（2026-10-12，两拨人都踩到）**：用私有 index 提交后，**共享 `.git/index` 仍停在旧 HEAD 上** ✗
⇒ 你这次**新增的文件**在别人眼里会立刻变成 **`D ` staged 删除 + `??` 未跟踪**
（下一次**裸提交/按 index 提交会把它们删掉** ✗）。

**收尾动作（只动自己的路径，别碰别人的）**：
```bash
git reset -q HEAD -- <你这次提交涉及的路径…>      # 或等价地 git add -- <同样这些路径>
```
之后：你自己的路径恢复干净，**别人的 staged/worktree 改动逐条原样保留** ✓（用前/后 `git status --short` 对比自证）。

> 同一轮里另有两位队友独立踩到这条并各自发现，故写入配方。

### `frontend/.next` 是硬冲突资源

并发 `next build` / `NEXT_EXPORT=1 pnpm build` 会**覆盖 `frontend/.next`**，而 e2e 的
`next dev` 也读写同一目录 ⇒ 客户端分块变 500（`Cannot find module './xxxx.js'`）⇒
**不 hydration ⇒ MSW 不运行 ⇒ 零请求 ⇒ 页面全白** ⇒ **e2e 那一轮数字全部作废**（不是产品信号）。

- **构建/导出 与 e2e 不能同时跑**；跑 e2e 前先确认 `/_next/static/chunks/main-app.js` 返回 200。
- **构建门的数字只在工作区静止时作数**（`NEXT_DIST_DIR` 只隔离产物目录，**不隔离源码并发写**）。

## 5. 测量纪律（本项目已因此错过多次）

- **宣布任何"通过 / 失败 / 归零"之前，必须先打印完整、不过滤的摘要**，
  并核对 `passed + failed + skipped == playwright test --list 的总数`。
  **数字对不上就是证据不足，不是"没问题"。**（曾用过滤视图得出过假的"0 failed"，
  并用整轮撤回。）
- **"没匹配上" ≠ "没有"**：grep **0 命中**可能只是**命令没跑在预期对象上**；
  `[绕过MSW]` 这类探针在请求 **abort 时不会打日志** ⇒ "日志里没有" 不等于 "被拦住了"。
  下结论前要用**阳性对照**或打印 cwd 确认工具确实作用在预期对象上。
- **不要用关键字 grep 当"某文案 / 控件不存在"的证据** —— 要**真实报错**或**渲染快照**。
  （曾据此错判 `events`、`kb` 两条，被迫更正。）
- **通过数在环境不稳时没有比较意义**。只有**确定性信号**（错误消息、请求/响应证据、
  源码事实）配作为依据；"通过数变好了"不能当改善的证据。
- **并发会让门禁出现瞬态红**（别人改到一半）⇒ 先复查再认领，**但也不能拿它当借口**：
  要复跑确认"现在通过"才能下结论。
