"""
Kaas v2 · KB Client 抽象层 (§13.2)
────────────────────────────────────
ABC + StubKBClient + FastGPTKBClient。

⚠️ DEPRECATED — 请使用 knowledge_provider 模块
   KnowledgeRetrievalProvider / PostgreSQLTextKnowledgeProvider。
   此模块仅保留用于向后兼容的可选 FastGPT provider 包装。
   新代码不得直接 import 此模块中的类或函数。
   核心路径 (quote / pricing / orchestrator) 已禁止直接 import。
"""
import os
import time
import warnings
from abc import ABC, abstractmethod

import httpx
from app.services.http_utils import retry_request
from app.core.metrics import KB_LATENCY


class KBClient(ABC):
    @abstractmethod
    async def search(
        self,
        dataset_ids: list[str],
        query: str,
        top_k: int = 5,
    ) -> list[dict]:
        """知识库检索，返回相关规格/价格参考条目。"""

    async def close(self):
        """可选资源清理。"""
        pass


class StubKBClient(KBClient):
    """本轮测试用 stub：返回固定 mock 数据。"""

    _MOCK_DATA = {
        "牛栏网": [
            {"spec": {"mesh": "50x50", "wire": "2.5"}, "unit_price": 12.5, "unit": "m²"},
            {"spec": {"mesh": "60x60", "wire": "3.0"}, "unit_price": 15.0, "unit": "m²"},
            {"spec": {"mesh": "50x50", "wire": "3.0"}, "unit_price": 14.0, "unit": "m²"},
        ],
        "石笼网": [
            {"spec": {"mesh": "80x100", "wire": "2.7"}, "unit_price": 8.5, "unit": "m²"},
            {"spec": {"mesh": "100x120", "wire": "3.0"}, "unit_price": 10.0, "unit": "m²"},
        ],
    }

    def _extract_category(self, dataset_ids: list[str]) -> str:
        """从 dataset_id 列表中提取品类名，用于 stub 查找。"""
        known = set(self._MOCK_DATA.keys())
        for ds in dataset_ids:
            for cat in known:
                if cat in ds:
                    return cat
        return ""

    async def search(
        self,
        dataset_ids: list[str],
        query: str,
        top_k: int = 5,
    ) -> list[dict]:
        category = self._extract_category(dataset_ids)
        results = self._MOCK_DATA.get(category, [])
        return results[:top_k]


# ═══════════════════════════════════════════════════════════════════
# FastGPTKBClient (§13.1 · 真实 FastGPT 检索引擎)
# ═══════════════════════════════════════════════════════════════════

class FastGPTKBClient(KBClient):
    """反向调 FastGPT 知识库 /api/core/dataset/searchTest。

    铁律2: FastGPT 仅当检索引擎，不做任何 AI 决策。
    铁律4: FastGPT 工作流 0 AI 节点，Orchestrator 是大脑。
    """

    def __init__(self, tenant_id: str):
        from app.domain.tenant_config import load_tenant_config
        cfg = load_tenant_config(tenant_id)
        if not cfg:
            raise ValueError(f"Unknown tenant: {tenant_id}")
        self._tenant_id = tenant_id
        api_key_ref = cfg.get("fastgpt_api_key_ref", "")
        env_key = api_key_ref.replace("ENV:", "")
        self.api_key = os.environ[env_key]
        self.base_url = os.environ["FASTGPT_BASE_URL"]
        self.timeout = float(os.getenv("KB_TIMEOUT_SECONDS", "10"))
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            headers={"Authorization": f"Bearer {self.api_key}"},
            timeout=self.timeout,
        )

    async def search(
        self,
        dataset_ids: list[str],
        query: str,
        top_k: int = 5,
    ) -> list[dict]:
        """调 FastGPT /api/core/dataset/searchTest 做纯向量检索。"""
        start = time.perf_counter()
        try:
            resp = await retry_request(
                self._client, "POST", "/api/core/dataset/searchTest",
                json={
                    "datasetIds": dataset_ids,
                    "text": query,
                    "limit": top_k,
                    "searchMode": "embedding",
                },
            )
            resp.raise_for_status()
            data = resp.json()
            # 防御性解析: 兼容 list 和 data 两种 key
            results = data.get("list", data.get("data", []))
            return [
                {
                    "content": item.get("a") or item.get("q", ""),
                    "question": item.get("q", ""),
                    "score": item.get("score", 0),
                    "dataset_id": item.get("datasetId", ""),
                }
                for item in results[:top_k]
            ]
        finally:
            elapsed = time.perf_counter() - start
            KB_LATENCY.labels(tenant_id=getattr(self, "_tenant_id", "unknown")).observe(elapsed)

    async def close(self):
        await self._client.aclose()


# ═══════════════════════════════════════════════════════════════════
# 工厂 (§13.2)
# ═══════════════════════════════════════════════════════════════════

_KB_CLIENTS: dict[str, type] = {
    "fastgpt": FastGPTKBClient,
    "stub": StubKBClient,
}


def get_kb_client(tenant_id: str = "") -> KBClient:
    """工厂函数，读 KB_PROVIDER env 决定实例。

    ⚠️ DEPRECATED — 请使用 knowledge_provider.get_knowledge_provider()。
       此函数仅保留用于 FastGPTKnowledgeProvider 的向后兼容包装。
       新代码应使用：
         from app.services.knowledge_provider import get_knowledge_provider
         provider = get_knowledge_provider(tenant_id)

    tenant_id 仅在 FastGPT 模式下需要（获取 API key ref）。
    """
    warnings.warn(
        "get_kb_client() is DEPRECATED. Use get_knowledge_provider() from knowledge_provider module instead.",
        DeprecationWarning,
        stacklevel=2,
    )
    provider = os.getenv("KB_PROVIDER", "stub")
    if provider == "fastgpt":
        return FastGPTKBClient(tenant_id)
    elif provider == "stub":
        return StubKBClient()
    else:
        raise ValueError(f"Unknown KB_PROVIDER: {provider}")
