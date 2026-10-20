/**
 * C10 防回归：18 类单证模板的**末尾原子块**必须整体分页
 *
 * 背景（TODO C10 / `docs/TRADE_DOC_TEMPLATES.md` §九）：
 * 签章区、公章、紧邻的声明/条款/备注块原先可能被分页切开 —— 最难看的是
 * 「买方回签在上一页、卖方公章在下一页」。实测（2026-10-11，Chromium）
 * `break-before/after: avoid` **被忽略**，纯 CSS 保证不了，只能由模板把末尾几块
 * 包进一个 `break-inside: avoid` 容器。本文件用**静态读取模板**钉住这件事：
 *
 *  · 每个模板**恰好一个** `.keep-together` 容器；
 *  · 容器必须包住签章区（`table.sign`）与页脚（`.foot`），且页脚在容器内闭合；
 *  · **正文长表格/行项不得进容器**（items 表必须保持可跨页）；
 *  · 共享样式在 `@media print` 里定义了 `.keep-together` 的两条分页规则。
 *
 * ⚠️ **这不是视觉验收**：本测试只证明"容器存在且位置正确"。
 * 真实分页效果（PDF/打印）必须等 `pnpm build` + e2e / 人工打印复核，
 * 本任务**没有**、也**不能**声称已完成视觉验证。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const assets = JSON.parse(
  readFileSync(join(HERE, "..", "assets.json"), "utf-8"),
) as {
  templates: Record<string, string>;
  sharedStyle: string;
};
const manifest = JSON.parse(
  readFileSync(join(HERE, "..", "manifest.json"), "utf-8"),
) as Record<string, unknown>;

const DOC_TYPES = Object.keys(manifest);
const KEEP_OPEN = '<div class="keep-together">';
const FOOT = '<div class="foot">$footer_note</div>';

describe("C10：18 类模板末尾原子块 keep-together", () => {
  it("覆盖全部 18 类单证（不是 17、也不是 19）", () => {
    expect(DOC_TYPES.length).toBe(18);
    expect(Object.keys(assets.templates).sort()).toEqual(DOC_TYPES.sort());
  });

  it.each(DOC_TYPES)("%s 恰好一个容器，且包住签章区与页脚", (docType) => {
    const template = assets.templates[docType] ?? "";
    expect(template, `${docType} 模板缺失`).not.toBe("");

    const openCount = template.split(KEEP_OPEN).length - 1;
    expect(openCount, `${docType} 应恰好一个 .keep-together 容器`).toBe(1);

    const openAt = template.indexOf(KEEP_OPEN);
    // 注意 sign 表可能带内联样式（汇票是 `style="margin-top: 10mm;"`），故只匹配开头
    const signAt = template.indexOf('<table class="sign"');
    const footAt = template.indexOf(FOOT);
    expect(signAt, `${docType} 缺签章区`).toBeGreaterThan(-1);
    expect(footAt, `${docType} 缺页脚`).toBeGreaterThan(-1);

    // 容器必须**在签章区之前开始**、且页脚在容器内（容器闭合紧跟页脚）
    expect(openAt, `${docType} 容器未包住签章区`).toBeLessThan(signAt);
    expect(footAt, `${docType} 容器未包住页脚`).toBeGreaterThan(openAt);
    expect(
      template.slice(footAt + FOOT.length, footAt + FOOT.length + 20),
      `${docType} 容器闭合位置不对（页脚之后应立即闭合）`,
    ).toContain("</div>");
  });

  it.each(DOC_TYPES)("%s 正文表格/行项不在容器内（必须可跨页）", (docType) => {
    const template = assets.templates[docType] ?? "";
    const openAt = template.indexOf(KEEP_OPEN);
    for (const marker of ['class="items"', "$items"]) {
      const at = template.indexOf(marker);
      if (at < 0) continue;
      expect(
        at,
        `${docType} 把正文表格/行项（${marker}）包进了原子块，长表格将无法跨页`,
      ).toBeLessThan(openAt);
    }
  });

  it("共享样式在 @media print 里声明 keep-together 的两条分页规则", () => {
    const css = assets.sharedStyle;
    const printAt = css.indexOf("@media print");
    const keepAt = css.indexOf(".keep-together {");
    expect(printAt).toBeGreaterThan(-1);
    expect(keepAt, "共享样式缺 .keep-together 规则").toBeGreaterThan(printAt);
    const rule = css.slice(keepAt, css.indexOf("}", keepAt));
    expect(rule).toContain("page-break-inside: avoid");
    expect(rule).toContain("break-inside: avoid");
  });

  it("渲染结果里容器是真实 HTML（不是只写在模板注释里）", async () => {
    const { renderTradeDoc } = await import("../render");
    const sample = JSON.parse(
      readFileSync(join(HERE, "..", "sample-data.json"), "utf-8"),
    ) as { base: Record<string, unknown>; other_extra: Record<string, unknown> };
    for (const docType of DOC_TYPES) {
      const html = renderTradeDoc(docType, {
        ...sample.base,
        ...(docType === "other" ? sample.other_extra : {}),
      });
      expect(html, `${docType} 渲染结果缺 keep-together`).toContain(KEEP_OPEN);
      expect(html).toContain("</div>");
    }
  });
});
