/**
 * 「中译英」面板（`doc-translate-panel.tsx`）交互测试（A13）。
 *
 * 钉住诚实性（任务的核心验收点）：
 * - `path=ai:<provider>` ⇒ 显示"AI 翻译（provider）"，draft 显示"已写回草稿"；
 * - `path=template` ⇒ 必须显示"AI 不可用 / 原样返回 / 请人工翻译"，**不能**出现"AI 翻译"；
 * - 非 draft ⇒ 显示"未写回（非草稿）"；
 * - 没有中文字段 ⇒ 空态、不发请求；
 * - 勾选控制 ⇒ 请求体只带勾选字段。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const mocks = vi.hoisted(() => ({
  translate: vi.fn(),
  renderData: null as unknown,
}));

// 路径相对**测试文件**解析（面板里写的是 ../hooks/…）
vi.mock("../../hooks/use-trade-docs", () => ({
  useTradeDocRenderData: () => ({ data: mocks.renderData }),
  useTranslateTradeDoc: () => ({
    mutateAsync: mocks.translate,
    isPending: false,
    isError: false,
    error: null,
  }),
}));

import { DocTranslatePanel } from "../doc-translate-panel";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function flush(times = 6): Promise<void> {
  return new Promise((resolve) => {
    let left = times;
    const tick = () => {
      if (left-- <= 0) return resolve();
      setTimeout(tick, 0);
    };
    tick();
  });
}

function renderPanel(status: string | null = "draft"): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(<DocTranslatePanel docId={7} status={status} />);
  });
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await flush();
  });
}

function buttonByText(text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find((btn) =>
    (btn.textContent ?? "").includes(text),
  );
  if (!found) throw new Error(`找不到按钮「${text}」`);
  return found as HTMLButtonElement;
}

function text(): string {
  return container.textContent ?? "";
}

function renderDataOf(
  custom: Record<string, unknown>,
  options: { docType?: string; status?: string } = {},
): unknown {
  return {
    doc: {
      id: 7,
      doc_no: "DOC-1",
      doc_type: options.docType ?? "pi",
      status: options.status ?? "draft",
      raw_payload: { custom },
    },
    data: {},
    company_profile_configured: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.renderData = renderDataOf({ remarks: "请尽快发货" });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("中译英面板 · AI 成功路径", () => {
  it("draft：只发勾选字段的原文，展示译文并提示「已写回草稿」", async () => {
    mocks.translate.mockResolvedValue({
      fields: { remarks: "Please ship the goods as soon as possible" },
      path: "ai:kimi",
      task: "trade_doc_translate",
    });
    renderPanel("draft");

    await click(buttonByText("翻译为英文"));

    expect(mocks.translate).toHaveBeenCalledTimes(1);
    expect(mocks.translate).toHaveBeenCalledWith({
      fields: { remarks: "请尽快发货" },
      target: "en",
    });
    const shown = text();
    expect(shown).toContain("AI 翻译（kimi）");
    expect(shown).toContain("已写回草稿");
    expect(shown).toContain("Please ship the goods as soon as possible");
    expect(shown).not.toContain("AI 不可用");
  });

  it("非 draft：如实提示「未写回（非草稿）」，不伪装已保存", async () => {
    mocks.translate.mockResolvedValue({
      fields: { remarks: "Please ship ASAP" },
      path: "ai:kimi",
      task: "trade_doc_translate",
    });
    renderPanel("issued");

    await click(buttonByText("翻译为英文"));

    const shown = text();
    expect(shown).toContain("AI 翻译（kimi）");
    expect(shown).toContain("未写回（非草稿）");
    expect(shown).not.toContain("已写回草稿");
  });

  it("AI 路径下个别字段等于原文 ⇒ 逐行标「未翻译（回退原文）」", async () => {
    mocks.renderData = renderDataOf({
      remarks: "请尽快发货",
      shipping_marks: "河北安平",
    });
    mocks.translate.mockResolvedValue({
      fields: {
        remarks: "Please ship ASAP",
        shipping_marks: "河北安平", // 模型没译到 ⇒ 后端回退原文
      },
      path: "ai:kimi",
      task: "trade_doc_translate",
    });
    renderPanel("draft");

    await click(buttonByText("翻译为英文"));

    expect(text()).toContain("未翻译（回退原文）");
  });
});

describe("中译英面板 · AI 不可用降级（path=template）", () => {
  it("必须显示「AI 不可用 / 原样返回 / 请人工翻译」，且不出现「AI 翻译」", async () => {
    mocks.translate.mockResolvedValue({
      fields: { remarks: "请尽快发货" }, // 原样返回
      path: "template",
      task: "trade_doc_translate",
    });
    renderPanel("draft");

    await click(buttonByText("翻译为英文"));

    const shown = text();
    expect(shown).toContain("AI 不可用");
    expect(shown).toContain("原样返回");
    expect(shown).toContain("人工翻译");
    expect(shown).toContain("未翻译");
    // 不能把降级说成 AI 翻译
    expect(shown).not.toContain("AI 翻译（");
    // 原样值仍逐行展示（用户能看到返回了什么）
    expect(shown).toContain("请尽快发货");
  });
});

describe("中译英面板 · 字段选择与空态", () => {
  it("没有含中文的手工字段 ⇒ 空态，且不显示翻译按钮/不发请求", () => {
    mocks.renderData = renderDataOf({
      remarks: "Please ship ASAP",
      pi_no: "PI-2026-001",
    });
    renderPanel("draft");

    expect(text()).toContain("当前没有需要翻译的中文字段");
    expect(
      Array.from(container.querySelectorAll("button")).some((btn) =>
        (btn.textContent ?? "").includes("翻译为英文"),
      ),
    ).toBe(false);
    expect(mocks.translate).not.toHaveBeenCalled();
  });

  it("取消勾选后请求体只带勾选字段", async () => {
    mocks.renderData = renderDataOf(
      { inspection: "第三方检验", claims: "按合同约定索赔" },
      { docType: "contract" },
    );
    mocks.translate.mockResolvedValue({
      fields: {
        inspection: "Third-party inspection",
        claims: "按合同约定索赔",
      },
      path: "ai:deepseek",
      task: "trade_doc_translate",
    });
    renderPanel("draft");

    // 取消 claims
    const claimsCheckbox = container.querySelector(
      'input[aria-label="选择翻译字段 claims"]',
    ) as HTMLInputElement;
    await act(async () => {
      claimsCheckbox.click();
      await flush();
    });

    await click(buttonByText("翻译为英文"));

    expect(mocks.translate).toHaveBeenCalledWith({
      fields: { inspection: "第三方检验" },
      target: "en",
    });
    // 结果区只含被请求的字段（未勾选的字段仍在上方的候选清单里，属正常）
    const result = container.querySelector(
      '[data-testid="translate-result"]',
    ) as HTMLElement | null;
    expect(result).not.toBeNull();
    expect(result!.textContent).toContain("Third-party inspection");
    expect(result!.textContent).not.toContain("按合同约定索赔");
  });
});
