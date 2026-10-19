"""单证数据装配 —— 把「上游快照 + 企业主体 + 买方 + 手工填写」合成渲染数据。

**实现已下沉到共享内核** `kaas_common.trade_doc.payload_shared`，
本模块仅保留向后兼容的 re-export（旧 import 路径 `app.services.trade_doc_payload` 不破坏）。

业务位置
--------
    询盘 → 报价单 → 订单 → 单证
                 ↑        ↑
              谈定条款   继承条款
"""
from kaas_common.trade_doc.payload_shared import (  # noqa: F401
    DOC_NO_FIELDS,
    TRADE_TERM_FIELDS,
    item_from_source,
    buyer_block,
    trade_terms_of,
    build_render_data,
)

