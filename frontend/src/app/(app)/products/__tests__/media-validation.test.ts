/**
 * 产品图上传的前端预校验 —— 口径必须与后端 `kaas_common/files/rules.py` 一致。
 *
 * 这层测试的真正价值不是"函数返回对不对"，而是**把后端口径钉住**：
 * 一旦有人改了 `MEDIA_MAX_BYTES` 或允许的类型，这里会红，
 * 从而不会出现"前端放行、后端 422"的割裂（用户白等一次完整上传才看到错误）。
 */
import { describe, expect, it } from "vitest";

import {
  MEDIA_ACCEPT,
  MEDIA_MAX_BYTES,
  MEDIA_MIME,
  MEDIA_NAME_MAX,
  defaultMediaName,
  formatBytes,
  resolveMediaContentType,
  validateMediaFile,
  validateMediaName,
} from "../media-validation";

function file(name: string, type: string, size: number) {
  return { name, type, size };
}

describe("常量与后端规则对齐", () => {
  it("类型只允许 PNG / JPEG / WebP", () => {
    expect([...MEDIA_MIME]).toEqual(["image/png", "image/jpeg", "image/webp"]);
    expect(MEDIA_ACCEPT).toBe("image/png,image/jpeg,image/webp");
  });

  it("上限 8 MB、名称 80 字符", () => {
    expect(MEDIA_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(MEDIA_NAME_MAX).toBe(80);
  });
});

describe("resolveMediaContentType（浏览器给空类型时按扩展名兜底）", () => {
  it("浏览器给了合法类型就用它", () => {
    expect(resolveMediaContentType(file("a.png", "image/png", 10))).toBe("image/png");
  });

  it("带 charset 等参数也能识别", () => {
    expect(resolveMediaContentType(file("a.jpg", "image/jpeg; charset=binary", 10))).toBe(
      "image/jpeg",
    );
  });

  it("空类型 ⇒ 按扩展名推断（截图工具常见）", () => {
    expect(resolveMediaContentType(file("shot.PNG", "", 10))).toBe("image/png");
    expect(resolveMediaContentType(file("shot.jpeg", "", 10))).toBe("image/jpeg");
    expect(resolveMediaContentType(file("shot.webp", "", 10))).toBe("image/webp");
  });

  it("类型非法但扩展名合法 ⇒ 以扩展名为准（避免后端按空/错类型拒）", () => {
    expect(resolveMediaContentType(file("a.png", "application/octet-stream", 10))).toBe(
      "image/png",
    );
  });

  it("扩展名不认识 ⇒ null", () => {
    expect(resolveMediaContentType(file("a.gif", "", 10))).toBeNull();
    expect(resolveMediaContentType(file("noext", "image/gif", 10))).toBeNull();
  });
});

describe("validateMediaFile（入队即拦，错误带实际值）", () => {
  it("合规文件返回 null", () => {
    expect(validateMediaFile(file("a.png", "image/png", 1024))).toBeNull();
  });

  it("空文件先报（比类型/大小更根本）", () => {
    const reject = validateMediaFile(file("a.png", "image/png", 0));
    expect(reject?.code).toBe("BAD_SIZE");
    expect(reject?.message).toContain("0 字节");
  });

  it("类型不支持 ⇒ 消息里写出实际类型", () => {
    const reject = validateMediaFile(file("a.gif", "image/gif", 100));
    expect(reject?.code).toBe("BAD_CONTENT_TYPE");
    expect(reject?.message).toContain("image/gif");
  });

  it("空类型且扩展名也不认识 ⇒ 说「未知类型」而不是留空", () => {
    const reject = validateMediaFile(file("a", "", 100));
    expect(reject?.code).toBe("BAD_CONTENT_TYPE");
    expect(reject?.message).toContain("未知类型");
  });

  it("超过 8 MB ⇒ 同时给出上限与实际大小", () => {
    const reject = validateMediaFile(
      file("big.png", "image/png", MEDIA_MAX_BYTES * 2),
    );
    expect(reject?.code).toBe("FILE_TOO_LARGE");
    expect(reject?.message).toContain("8.0 MB"); // 上限
    expect(reject?.message).toContain("16.0 MB"); // 实际值，用户据此判断要压多少
  });

  it("恰好 8 MB 放行（后端是 > 才拒）", () => {
    expect(validateMediaFile(file("edge.png", "image/png", MEDIA_MAX_BYTES))).toBeNull();
  });

  it("校验顺序：空文件优先于类型错误", () => {
    expect(validateMediaFile(file("a.gif", "image/gif", 0))?.code).toBe("BAD_SIZE");
  });
});

describe("validateMediaName", () => {
  it("空白 ⇒ 要求起名（单证引用时得认得出）", () => {
    expect(validateMediaName("   ")).toContain("起个名字");
  });

  it("超长 ⇒ 说出上限", () => {
    expect(validateMediaName("x".repeat(MEDIA_NAME_MAX + 1))).toContain("80");
  });

  it("首尾空白不算长度（trim 后判定）", () => {
    expect(validateMediaName(`  ${"x".repeat(MEDIA_NAME_MAX)}  `)).toBeNull();
  });
});

describe("defaultMediaName", () => {
  it("去掉扩展名", () => {
    expect(defaultMediaName("2m×20m 侧面.png")).toBe("2m×20m 侧面");
  });

  it("多个点只去最后一段", () => {
    expect(defaultMediaName("v1.2 尺寸图.jpg")).toBe("v1.2 尺寸图");
  });

  it("没有文件名 ⇒ 给个可读兜底，不留空", () => {
    expect(defaultMediaName(".png")).toBe("未命名图片");
  });

  it("超长截到 80", () => {
    expect(defaultMediaName(`${"y".repeat(120)}.png`)).toHaveLength(MEDIA_NAME_MAX);
  });
});

describe("formatBytes", () => {
  it("按量级选单位", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1536 * 1024)).toBe("1.5 MB");
  });

  it("非法值不显示 NaN", () => {
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(-1)).toBe("0 B");
  });
});
