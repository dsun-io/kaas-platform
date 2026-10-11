"""产品信息增补 `enrich_product` 的行为测试。

它不是爬取主体（主体是网页抽取），而是**AI 增补**。正因为如此，
它的正确性主要不在"能不能填对"，而在**"该不该调、调挂了会怎样"**：
爬取必须因为 AI 不可用而判失败吗？答案是不能。
"""
import pytest

from app.services.lead_crawl import enrich_product

pytestmark = pytest.mark.unit


class _Recorder:
    """记录被调用的任务与入参，并可按任务返回或抛错。"""

    def __init__(self, spec=None, cn=None, boom=()):
        self.calls = []
        self.spec = spec
        self.cn = cn
        self.boom = set(boom)

    async def __call__(self, db, tenant_id, task_key, payload):
        self.calls.append((tenant_id, task_key))
        if task_key in self.boom:
            raise RuntimeError("AI 不可用")
        if task_key == "spec_extract":
            return {"result": {"spec_normalized": self.spec}}
        return {"result": {"product_name_cn": self.cn}}


class TestNoOpWhenNothingToEnrich:
    async def test_no_ai_call_without_name_or_spec(self):
        """没有产品名也没有规格原文 → 不该调 AI（省一次调用，也别喂空字段）。"""
        rec = _Recorder(spec={"a": 1}, cn="名字")
        lead = {}
        await enrich_product(None, "t1", lead, ai_runner=rec)
        assert rec.calls == []
        assert lead == {}


class TestSpecNormalized:
    async def test_fills_when_missing(self):
        rec = _Recorder(spec={"mesh": 100})
        lead = {"product_name": "fence"}
        await enrich_product(None, "t1", lead, ai_runner=rec)
        assert lead["spec_normalized"] == {"mesh": 100}
        assert ("t1", "spec_extract") in rec.calls

    async def test_does_not_overwrite_existing(self):
        """已有归一化结果就不该再算 —— 否则每次爬取都可能把人工校正覆盖掉。"""
        rec = _Recorder(spec={"new": 1})
        lead = {"product_name": "fence", "spec_normalized": {"kept": 1}}
        await enrich_product(None, "t1", lead, ai_runner=rec)
        assert lead["spec_normalized"] == {"kept": 1}
        assert ("t1", "spec_extract") not in rec.calls


class TestProductNameCn:
    async def test_translates_when_name_present(self):
        rec = _Recorder(cn="牛栏网")
        lead = {"product_name": "field fence"}
        await enrich_product(None, "t1", lead, ai_runner=rec)
        assert lead["product_name_cn"] == "牛栏网"

    async def test_skips_translation_without_name(self):
        rec = _Recorder(cn="不该被用")
        lead = {"spec_raw": "some spec"}
        await enrich_product(None, "t1", lead, ai_runner=rec)
        assert lead.get("product_name_cn") is None

    async def test_empty_translation_is_not_written(self):
        """回空串不能写进去 —— 空串看起来像"已翻译"，会让下游不再重试。"""
        rec = _Recorder(cn="")
        lead = {"product_name": "field fence"}
        await enrich_product(None, "t1", lead, ai_runner=rec)
        assert "product_name_cn" not in lead


class TestAiFailureIsBestEffort:
    """**最关键的一组**：AI 挂掉不能把整次爬取判为失败。

    爬取的主体成果是网页抽取（产品名/图片/规格都拿到了），
    AI 只是增补。若因为翻译服务不可用就抛错，等于把已经拿到的成果一起丢掉。
    """

    async def test_spec_failure_does_not_raise(self):
        rec = _Recorder(boom={"spec_extract"})
        lead = {"product_name": "fence"}
        await enrich_product(None, "t1", lead, ai_runner=rec)   # 不应抛
        assert lead.get("spec_normalized") is None

    async def test_translate_failure_does_not_raise(self):
        rec = _Recorder(boom={"product_translate"})
        lead = {"product_name": "fence"}
        await enrich_product(None, "t1", lead, ai_runner=rec)   # 不应抛
        assert lead.get("product_name_cn") is None

    async def test_one_failure_does_not_block_the_other(self):
        """两个任务是独立的：翻译挂了不该连累规格归一化。"""
        rec = _Recorder(spec={"ok": 1}, boom={"product_translate"})
        lead = {"product_name": "fence"}
        await enrich_product(None, "t1", lead, ai_runner=rec)
        assert lead["spec_normalized"] == {"ok": 1}
        assert lead.get("product_name_cn") is None
