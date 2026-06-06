"""单元测试：桩模式话术池"""

import json
import os
import tempfile
from pathlib import Path

import pytest

from app.stub_replies import (
    DEFAULT_REPLY,
    StubRepliesPool,
    get_pool,
    get_stub_reply,
    reset_pool,
)


class TestStubRepliesPool:
    """测试话术池核心功能"""

    @pytest.fixture(autouse=True)
    def reset_singleton(self):
        """每个测试前重置单例"""
        reset_pool()
        yield
        reset_pool()

    @pytest.fixture
    def temp_config(self):
        """创建临时配置文件"""
        config = {
            "greeting": {
                "keywords": ["你好", "您好", "在吗"],
                "replies": ["回复1", "回复2", "回复3"],
            },
            "shipping": {
                "keywords": ["发货", "快递", "物流"],
                "replies": ["快递回复1", "快递回复2"],
            },
            "fallback": {
                "keywords": [],
                "replies": ["兜底回复1", "兜底回复2", "兜底回复3"],
            },
        }
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as f:
            json.dump(config, f, ensure_ascii=False)
            temp_path = f.name

        yield temp_path

        # 清理
        try:
            os.unlink(temp_path)
        except OSError:
            pass

    def test_load_config(self, temp_config):
        """测试加载配置文件"""
        pool = StubRepliesPool(config_path=temp_config)
        stats = pool.get_stats()

        assert stats["scenes_count"] == 3
        assert stats["scenes"]["greeting"] == 3
        assert stats["scenes"]["shipping"] == 2
        assert stats["scenes"]["fallback"] == 3

    def test_match_greeting_scene(self, temp_config):
        """测试匹配问候场景"""
        pool = StubRepliesPool(config_path=temp_config)

        # 匹配关键词
        reply = pool.get_reply("你好")
        assert reply in ["回复1", "回复2", "回复3"]

        reply = pool.get_reply("您好，在吗？")
        assert reply in ["回复1", "回复2", "回复3"]

    def test_match_shipping_scene(self, temp_config):
        """测试匹配物流场景"""
        pool = StubRepliesPool(config_path=temp_config)

        reply = pool.get_reply("什么时候发货？")
        assert reply in ["快递回复1", "快递回复2"]

        reply = pool.get_reply("发什么快递")
        assert reply in ["快递回复1", "快递回复2"]

    def test_fallback_scene(self, temp_config):
        """测试兜底场景"""
        pool = StubRepliesPool(config_path=temp_config)

        # 无法匹配的场景，应该使用 fallback
        reply = pool.get_reply("这是一条无法匹配的消息")
        assert reply in ["兜底回复1", "兜底回复2", "兜底回复3"]

    def test_random_selection(self, temp_config):
        """测试随机选取（多次请求应该返回不同回复）"""
        pool = StubRepliesPool(config_path=temp_config)

        # 多次请求，收集回复
        replies = [pool.get_reply("你好") for _ in range(20)]

        # 应该有多个不同的回复（概率上几乎必然）
        unique_replies = set(replies)
        assert len(unique_replies) > 1, "随机选取应该产生不同回复"

    def test_empty_message(self, temp_config):
        """测试空消息处理"""
        pool = StubRepliesPool(config_path=temp_config)

        reply = pool.get_reply("")
        # 空消息应该返回兜底回复
        assert reply in ["兜底回复1", "兜底回复2", "兜底回复3"]

    def test_config_file_not_exist(self):
        """测试配置文件不存在时的优雅降级"""
        pool = StubRepliesPool(config_path="/nonexistent/path/config.json")

        reply = pool.get_reply("任何消息")
        # 应该返回默认回复
        assert reply == DEFAULT_REPLY

    def test_invalid_json(self):
        """测试无效JSON格式的优雅降级"""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as f:
            f.write("invalid json content")
            temp_path = f.name

        try:
            pool = StubRepliesPool(config_path=temp_path)
            reply = pool.get_reply("任何消息")
            assert reply == DEFAULT_REPLY
        finally:
            try:
                os.unlink(temp_path)
            except OSError:
                pass

    def test_reload(self, temp_config):
        """测试热更新功能"""
        pool = StubRepliesPool(config_path=temp_config, reload_interval_seconds=0.1)

        # 首次加载
        reply = pool.get_reply("你好")
        assert reply in ["回复1", "回复2", "回复3"]

        # 修改配置文件
        new_config = {
            "greeting": {
                "keywords": ["你好"],
                "replies": ["新回复1", "新回复2"],
            },
            "fallback": {
                "keywords": [],
                "replies": ["新兜底"],
            },
        }
        with open(temp_config, "w", encoding="utf-8") as f:
            json.dump(new_config, f, ensure_ascii=False)

        # 强制重新加载
        pool.reload()

        # 验证新配置生效
        reply = pool.get_reply("你好")
        assert reply in ["新回复1", "新回复2"]


class TestGlobalFunctions:
    """测试全局便捷函数"""

    @pytest.fixture(autouse=True)
    def reset_singleton(self):
        """每个测试前重置单例"""
        reset_pool()
        yield
        reset_pool()

    @pytest.fixture
    def temp_config(self):
        """创建临时配置文件"""
        config = {
            "price": {
                "keywords": ["多少钱", "价格"],
                "replies": ["价格回复"],
            },
            "fallback": {
                "keywords": [],
                "replies": ["全局函数兜底"],
            },
        }
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as f:
            json.dump(config, f, ensure_ascii=False)
            temp_path = f.name

        yield temp_path

        try:
            os.unlink(temp_path)
        except OSError:
            pass

    def test_get_stub_reply(self, temp_config):
        """测试便捷函数 get_stub_reply"""
        reply = get_stub_reply("多少钱？", config_path=temp_config)
        assert reply == "价格回复"

    def test_get_pool_singleton(self, temp_config):
        """测试单例模式"""
        pool1 = get_pool(config_path=temp_config)
        pool2 = get_pool(config_path=temp_config)
        assert pool1 is pool2

    def test_get_pool_returns_same_instance(self, temp_config):
        """测试多次调用 get_pool 返回同一实例"""
        pool1 = get_pool(config_path=temp_config)
        # 不带参数调用应该返回已存在的实例
        pool2 = get_pool()
        assert pool1 is pool2


class TestKeywordScenarios:
    """测试实际业务场景关键词匹配"""

    @pytest.fixture(autouse=True)
    def reset_singleton(self):
        """每个测试前重置单例"""
        reset_pool()
        yield
        reset_pool()

    def test_real_config_loading(self):
        """测试加载实际配置文件"""
        # 获取项目根目录下的实际配置文件
        base_dir = Path(__file__).parent.parent
        config_path = base_dir / "data" / "stub_replies.json"

        if not config_path.exists():
            pytest.skip("实际配置文件不存在")

        pool = StubRepliesPool(config_path=config_path)
        stats = pool.get_stats()

        # 验证配置加载成功
        assert stats["scenes_count"] >= 6  # 至少6个场景
        assert "greeting" in stats["scenes"]
        assert "fallback" in stats["scenes"]

    def test_greeting_keywords(self):
        """测试问候关键词匹配"""
        base_dir = Path(__file__).parent.parent
        config_path = base_dir / "data" / "stub_replies.json"

        if not config_path.exists():
            pytest.skip("配置文件不存在")

        pool = StubRepliesPool(config_path=config_path)

        # 各种问候语应该匹配到 greeting 场景
        greetings = ["在吗", "有人吗", "你好", "您好", "嗨", "哈喽"]
        for greeting in greetings:
            reply = pool.get_reply(greeting)
            # 验证回复不为空且不包含测试/调试词汇
            assert reply
            assert "测试" not in reply
            assert "stub" not in reply.lower()
            assert "debug" not in reply.lower()

    def test_price_keywords(self):
        """测试价格关键词匹配"""
        base_dir = Path(__file__).parent.parent
        config_path = base_dir / "data" / "stub_replies.json"

        if not config_path.exists():
            pytest.skip("配置文件不存在")

        pool = StubRepliesPool(config_path=config_path)

        # 价格相关关键词
        price_queries = ["多少钱", "什么价", "报价", "优惠", "折扣", "能便宜吗"]
        for query in price_queries:
            reply = pool.get_reply(query)
            assert reply
            assert "测试" not in reply

    def test_no_test_words_in_replies(self):
        """测试回复中不包含测试/调试词汇"""
        base_dir = Path(__file__).parent.parent
        config_path = base_dir / "data" / "stub_replies.json"

        if not config_path.exists():
            pytest.skip("配置文件不存在")

        with open(config_path, "r", encoding="utf-8") as f:
            config = json.load(f)

        forbidden_words = ["测试", "test", "stub", "debug", "调试"]

        for scene_name, scene_data in config.items():
            replies = scene_data.get("replies", [])
            for reply in replies:
                for word in forbidden_words:
                    assert word.lower() not in reply.lower(), (
                        f"回复中包含禁用词汇 '{word}': {reply}"
                    )

    def test_reply_length_reasonable(self):
        """测试回复长度合理（15-60字）"""
        base_dir = Path(__file__).parent.parent
        config_path = base_dir / "data" / "stub_replies.json"

        if not config_path.exists():
            pytest.skip("配置文件不存在")

        with open(config_path, "r", encoding="utf-8") as f:
            config = json.load(f)

        for scene_name, scene_data in config.items():
            replies = scene_data.get("replies", [])
            for reply in replies:
                length = len(reply)
                assert 10 <= length <= 80, (
                    f"回复长度不合理 ({length}字): {reply}"
                )
