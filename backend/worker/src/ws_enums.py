"""业务枚举字典（Worker 镜像 · 生产对齐）。

为什么需要这个文件
------------------
前端渲染下拉/标签全靠 `GET /api/v1/enums`（不变量11：禁止前端硬编码第二份常量）。
单证页（`frontend/src/app/(app)/trade-docs/hooks/use-trade-docs.ts:229`）启动就会调它，
而 worker 此前没有这条路由 —— 线上单证页的枚举下拉直接是空的。

真源只有一个
------------
`backend/orchestrator/app/domain/enums.py`，由 `scripts/sync-shared.ps1` 的第三段
镜像成 `kaas_common/domain/enums.py`（同一份文件，不是手抄），并且它的 `DOC_TYPE`
还被 `scripts/contracts-check.ts` 的 R3 规则与前端的 `manifest.json` 交叉校验。
**绝不在 worker 里另写一份常量表。**
"""
from __future__ import annotations

from kaas_common.domain.enums import ENUMS

import main as _main

app = _main.app


@app.get("/api/v1/enums")
async def list_enums():
    """返回前后端共用的合法值清单。

    与 orchestrator 的 `app/api/enums.py` 逐字同构（含「不需要鉴权」这一点）：
    内容是静态常量、非敏感，且前端在登录前后都可能取它渲染下拉。
    """
    return {k: list(v) for k, v in ENUMS.items()}
