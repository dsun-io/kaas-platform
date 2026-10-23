/**
 * FormField 收编：leadgen 抓取配置表单的 label 关联 + 校验错误 aria。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { LeadgenConfigFields } from "../components/leadgen-config-form";
import { LeadgenRunActions } from "../components/leadgen-run-actions";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(el: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(el as never));
}

/** 等价 testing-library 的 getByLabelText：label[for] → 控件 */
function byLabelText(text: string): HTMLElement | null {
  const label = Array.from(document.querySelectorAll("label")).find(
    (l) => (l.textContent ?? "").replace("\*", "").trim() === text,
  );
  const id = label?.getAttribute("for");
  return id ? document.getElementById(id) : null;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
});

describe("抓取配置 FormField", () => {
  const cfg = { region: "", industry: "", icp: "", quantity: 20, source: "demo" };

  it("5 个字段都有 label 关联（不再 placeholder 当 label）", () => {
    mount(
      <LeadgenConfigFields
        cfg={cfg}
        regions={["US"]}
        onChange={() => {}}
        onQuantityChange={() => {}}
      />,
    );

    expect(byLabelText("数据源")).toBeInstanceOf(HTMLSelectElement);
    expect(byLabelText("地区")).toBeInstanceOf(HTMLSelectElement);
    expect(byLabelText("行业关键词")).toBeInstanceOf(HTMLInputElement);
    expect(byLabelText("ICP 备注")).toBeInstanceOf(HTMLInputElement);
    expect(byLabelText("抓取数量")).toBeInstanceOf(HTMLInputElement);
  });

  it("行业关键词校验错误：aria-invalid + aria-describedby + role=alert", () => {
    mount(
      <LeadgenConfigFields
        cfg={cfg}
        regions={[]}
        onChange={() => {}}
        onQuantityChange={() => {}}
        industryError="行业关键词不能为空"
      />,
    );

    const input = byLabelText("行业关键词") as HTMLInputElement;
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const errorEl = document.getElementById(describedBy!);
    expect(errorEl?.getAttribute("role")).toBe("alert");
    expect(errorEl?.textContent).toContain("行业关键词不能为空");
  });

  it("校验不通过的问题清单本身也是 role=alert", () => {
    mount(
      <LeadgenRunActions
        validating={false}
        validation={{
          valid: false,
          issues: ["行业关键词不能为空"],
          path: "",
        }}
        onValidate={() => {}}
        onRun={() => {}}
        runPending={false}
        runError={null}
        onScan={() => {}}
        scanPending={false}
        scanError={null}
        onCrawlBatch={() => {}}
        crawlBatchPending={false}
        crawlBatchError={null}
        crawling={null}
      />,
    );

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "行业关键词不能为空",
    );
  });
});
