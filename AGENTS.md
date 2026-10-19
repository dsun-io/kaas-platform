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
- **本机工具链（2026-10-19 实机核对；换设备需重核）**：
  - DSH runtime：`C:\Users\76516\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`
    + `...\dependencies\pnpm\bin\pnpm.cjs`（注意是 `dependencies\pnpm\bin\pnpm.cjs`，不是 `node\pnpm\…`）。
  - 本机 PATH 上已有 `D:\Node.js\node.exe` 与 pnpm（`C:\Users\76516\AppData\Roaming\npm\pnpm.ps1`），
    一般可直接用 `pnpm` / `node`。
  - ⚠️ **本机没有 PowerShell 7**（`pwsh` 不在 PATH，只有 5.1）⇒ 所有 `pwsh scripts/…` 改用
    `powershell -ExecutionPolicy Bypass -File scripts/…`。
  - ⚠️ **PATH 上的 `python` 是 WindowsApps 占位符**（执行无输出、退出 1）⇒ 需要 Python 的命令
    （`scripts/route-parity.py`、`export_openapi.py` 等）一律用
    `backend/orchestrator/.venv/Scripts/python.exe`；worker 测试用 `uv run …`。
  - ⚠️ 用户名会变：本机是 `76516`；历史文档写过 `HJ` / `河北慷逊公司`，按旧路径调用会
    `CommandNotFoundException`。以 `$env:USERPROFILE` 为准。
  - git hook：`.husky/pre-commit` 调 `pnpm lint-staged`（实测本机可直接解析）。若换设备报
    `pnpm: command not found`，加一个无 BOM 文本 shim（内容 `exec "<node.exe>" "<pnpm.cjs>" "$@"`）
    放进 PATH，Windows 路径写进 shim 内部最稳。
  - ⚠️ **commitlint 的 `subject-case` 规则**禁止句首/帕斯卡大小写 ⇒ subject 用中文或**全小写**才过。

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

⚠️ **补丁（2026-10-12 下午场实测，又踩一次）**：上面这条 `git reset -q HEAD -- <路径>` **在
`GIT_INDEX_FILE` 环境变量还指向私有临时索引时是无效的** —— 它归位的是**私有索引**，共享
`.git/index` **照旧停在旧 HEAD**，症状完全一样（`D ` + `??`）。
**提交脚本里必须先把私有索引用完再清掉变量，两个动作分开**：

```bash
# ① 私有索引提交（GIT_INDEX_FILE 指向 %TEMP%）
git read-tree HEAD && git add -- <自家路径…> && git commit -m "…"
# ② 清掉变量后再归位共享索引（关键：不能和 ① 写在同一条 shell 里紧接着跑）
Remove-Item Env:GIT_INDEX_FILE          # PowerShell；bash 用 unset GIT_INDEX_FILE
git add -- <自家路径…>                   # 用 add 最稳：让共享 index 与工作树/HEAD 一致
git status --short                       # 自证：自家路径干净，别人的改动原样在
```
判据：`git diff HEAD -- <自家路径>` **为空** 且 `git status --short -- <自家路径>` **无输出**，才算真归位。

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

## 6. 缺少东西时优先克服困难，而不是绕道

**用户原话（2026-10-11，当时口头答复"记下了"但 2026-10-12 才落盘 —— 本条就是迟到的补救，
本身即反例）**：

> 以后缺少的优先选择克服困难，而不是直接绕道

具体含义：

- **缺工具/缺环境 ≠ 做不了**：先想"用什么办法能把它验证/做出来"，而不是立刻退到次选方案。
  · 例：没有 Docker 起不了 MinIO ⇒ 用本地 `minio-py` 做**交叉验签** + 自建 stub S3 做真回环，
    照样把 S3 路径验死（2026-10-11 实测）。
  · 例：Cloudflare API 没有"创建 R2 S3 密钥"的端点 ⇒ 走通 dashboard 路径，并把步骤写进 FAQ，
    而不是砍掉 S3 方案。
  · 例：构建被并发的 `next dev` 弄红 ⇒ 定位为"产物目录争用"，加 `NEXT_DIST_DIR` 隔离，
    而不是跳过构建门禁。
- **可以临时回退，但要公开、要留回头路**：如 S3 落点的"binding 优先、失败自动回退 inline"
  是**显式记录 storage 落点**的回退，不是偷偷降级；回退后要把"正路还缺什么"写进文档待办。
- **例外**：用户明确说"先算了/到此为止"时，按用户裁决停手并如实记录边界（≠ 自己放弃）。
- **把这条规则本身写进本文档**就是一次教训：口头"记下了"不算数，用户下达的**长期行为准则**
  必须像规则 1–5 一样**当场落盘**，否则下一个会话不会自动遵守。
