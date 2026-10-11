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
- 环境无 `pnpm`/`npm` 可直接调用，用
  `C:\Users\HJ\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`
  + `...\pnpm\bin\pnpm.mjs`。跑 `.ps1` 前先
  `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force`。
