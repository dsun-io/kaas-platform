"""文件域共享内核 纯单测（无 DB、无三方依赖）。

`pytestmark = unit`：这是纯函数测试，**必须**进 `-m unit` 门禁 ——
否则"文件归属/版本化"的回归只有全量跑才看得见（本仓库已踩过：内核单测漏标 unit）。
"""
import pytest

from kaas_common.files import (
    FILE_KINDS,
    KIND_MIME,
    MAX_BYTES,
    MEDIA_KINDS,
    FileRuleError,
    current_of,
    file_ext,
    next_version,
    object_key,
    validate_upload,
)

pytestmark = pytest.mark.unit


def _ok(**over):
    base = dict(
        owner_type="product",
        kind="product_photo",
        media_kind="size",
        name="勾花网尺寸图",
        content_type="image/jpeg",
        size=123456,
    )
    base.update(over)
    return base


class TestValidateUpload:
    def test_product_photo_ok(self):
        validate_upload(**_ok())  # 不抛即通过

    def test_product_photo_requires_media_kind(self):
        with pytest.raises(FileRuleError) as e:
            validate_upload(**_ok(media_kind=None))
        assert e.value.code == "MEDIA_KIND_REQUIRED"

    def test_requires_user_given_name(self):
        """用户要求「上传图片以后有一个输入框给图片命名」⇒ 名称必填。"""
        with pytest.raises(FileRuleError) as e:
            validate_upload(**_ok(name="   "))
        assert e.value.code == "NAME_REQUIRED"

    def test_name_length_limit(self):
        with pytest.raises(FileRuleError) as e:
            validate_upload(**_ok(name="图" * 81))
        assert e.value.code == "NAME_TOO_LONG"

    def test_kind_rejects_wrong_mime(self):
        # PDF 不能当产品照片
        with pytest.raises(FileRuleError) as e:
            validate_upload(**_ok(content_type="application/pdf"))
        assert e.value.code == "BAD_CONTENT_TYPE"
        # 图片不能当系统渲染的 PDF
        with pytest.raises(FileRuleError):
            validate_upload(**_ok(kind="render_pdf", media_kind=None,
                                  content_type="image/png"))

    def test_stamp_scan_accepts_pdf_and_image(self):
        """客户盖章回传可能是扫描件 PDF，也可能是手机拍照的 jpg。"""
        validate_upload(**_ok(kind="stamp_scan", media_kind=None, content_type="application/pdf"))
        validate_upload(**_ok(kind="stamp_scan", media_kind=None, content_type="image/png"))

    def test_size_limits(self):
        with pytest.raises(FileRuleError) as e:
            validate_upload(**_ok(size=MAX_BYTES["product_photo"] + 1))
        assert e.value.code == "FILE_TOO_LARGE"
        with pytest.raises(FileRuleError) as e:
            validate_upload(**_ok(size=0))
        assert e.value.code == "BAD_SIZE"

    def test_bad_owner_and_kind(self):
        with pytest.raises(FileRuleError) as e:
            validate_upload(**_ok(owner_type="nope"))
        assert e.value.code == "BAD_OWNER_TYPE"
        with pytest.raises(FileRuleError) as e:
            validate_upload(**_ok(kind="nope"))
        assert e.value.code == "BAD_FILE_KIND"

    def test_media_kinds_are_the_four_business_types(self):
        assert set(MEDIA_KINDS) == {"production", "size", "weight", "finished", "other"}
        assert FILE_KINDS == ("product_photo", "stamp_scan", "render_pdf", "other")
        assert set(KIND_MIME["product_photo"]) == {"image/png", "image/jpeg", "image/webp"}


class TestObjectKey:
    def test_deterministic_and_dedupe_by_sha(self):
        a = object_key(tenant_id="default", owner_type="product", owner_id="chain_link",
                       kind="product_photo", media_kind="size", sha256="AB" * 32,
                       content_type="image/jpeg")
        b = object_key(tenant_id="default", owner_type="product", owner_id="chain_link",
                       kind="product_photo", media_kind="size", sha256="ab" * 32,
                       content_type="image/jpeg")
        assert a == b, "同一份内容必须落到同一个 key（同图重复上传不产生第二份字节）"
        assert a.startswith("t/default/product/chain_link/product_photo/size/")
        assert a.endswith(".jpg")

    def test_media_kind_separates_paths(self):
        size = object_key(tenant_id="default", owner_type="product", owner_id="chain_link",
                          kind="product_photo", media_kind="size", sha256="c" * 64,
                          content_type="image/png")
        weight = object_key(tenant_id="default", owner_type="product", owner_id="chain_link",
                            kind="product_photo", media_kind="weight", sha256="c" * 64,
                            content_type="image/png")
        assert size != weight
        assert "/size/" in size and "/weight/" in weight

    def test_segments_are_sanitized(self):
        key = object_key(tenant_id="default", owner_type="product", owner_id="a/b c?",
                         kind="product_photo", media_kind="finished", sha256="d" * 64,
                         content_type="image/webp")
        assert " " not in key and "?" not in key
        assert key.endswith(".webp")


class TestFileExt:
    def test_from_mime_then_filename(self):
        assert file_ext("image/png") == ".png"
        assert file_ext("image/jpeg; charset=x") == ".jpg"
        assert file_ext(None, "scan.PDF") == ".pdf"
        assert file_ext(None, "noext") == ""


class TestVersioning:
    """盖章回传「覆盖」= 版本化：新版本上位、旧版本留档（用户已裁决）。"""

    def test_first_upload_is_version_one(self):
        assert next_version(None) == (1, None)

    def test_next_version_supersedes_current(self):
        cur = {"id": 7, "version": 3, "is_current": True}
        assert next_version(cur) == (4, 7)

    def test_current_of_prefers_is_current_then_latest(self):
        rows = [
            {"id": 1, "version": 1, "is_current": False},
            {"id": 2, "version": 2, "is_current": True},
            {"id": 3, "version": 3, "is_current": False},
        ]
        assert current_of(rows)["id"] == 2
        no_flag = [{"id": 1, "version": 1}, {"id": 2, "version": 5}]
        assert current_of(no_flag)["id"] == 2
        assert current_of([]) is None
