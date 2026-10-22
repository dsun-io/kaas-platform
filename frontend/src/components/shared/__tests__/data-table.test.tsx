/**
 * DataTable（P0-C）——声明式列渲染 + 三态优先级 + 插槽 + 分页插槽。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { DataTable, type DataTableColumn } from "../data-table";
import { PaginationBar } from "../pagination-bar";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface Row {
  id: number;
  doc_no: string;
  amount: number | null;
  status: string;
}

const ROWS: Row[] = [
  { id: 1, doc_no: "PI-001", amount: 1200, status: "paid" },
  { id: 2, doc_no: "PI-002", amount: null, status: "draft" },
];

const COLUMNS: DataTableColumn<Row>[] = [
  { key: "doc_no", header: "单号" },
  { key: "amount", header: "金额", align: "right", width: 120 },
  {
    key: "status",
    header: "状态",
    render: (row) => <strong data-status={row.status}>{row.status}</strong>,
  },
];

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(ui: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(ui));
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
});

describe("DataTable", () => {
  it("按列定义渲染表头/单元格，支持 align/width 与 render 回调", () => {
    mount(
      <DataTable columns={COLUMNS} rows={ROWS} getRowKey={(row) => row.id} />,
    );

    const headers = Array.from(document.querySelectorAll("th"));
    expect(headers.map((h) => h.textContent)).toEqual(["单号", "金额", "状态"]);
    expect(headers.every((h) => h.getAttribute("scope") === "col")).toBe(true);
    expect(headers[1]?.className).toContain("text-right");
    expect((headers[1] as HTMLElement).style.width).toBe("120px");

    const bodyRows = document.querySelectorAll("tbody tr");
    expect(bodyRows.length).toBe(2);
    // 没有 render 的列取字段文本；null 显示占位符而不是 "null"
    expect(bodyRows[0]?.textContent).toContain("PI-001");
    expect(bodyRows[0]?.textContent).toContain("1200");
    expect(bodyRows[1]?.textContent).toContain("—");
    // render 回调优先生效
    expect(document.querySelector('[data-status="paid"]')).not.toBeNull();
  });

  it("loading 优先于空态：渲染 LoadingBlock（aria-busy）且不渲染表格", () => {
    mount(
      <DataTable
        columns={COLUMNS}
        rows={[]}
        getRowKey={(row) => row.id}
        loading
      />,
    );
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(document.querySelector("table")).toBeNull();
  });

  it("无数据渲染默认 EmptyState", () => {
    mount(
      <DataTable columns={COLUMNS} rows={[]} getRowKey={(row) => row.id} />,
    );
    expect(container?.textContent).toContain("暂无数据");
    expect(document.querySelector("table")).toBeNull();
  });

  it("空数据插槽可覆盖默认空态", () => {
    mount(
      <DataTable
        columns={COLUMNS}
        rows={[]}
        getRowKey={(row) => row.id}
        emptySlot={<p>还没有单证</p>}
      />,
    );
    expect(container?.textContent).toContain("还没有单证");
    expect(container?.textContent).not.toContain("暂无数据");
  });

  it("error 优先于 loading/空态，走 ErrorState 并可重试", () => {
    const onRetry = vi.fn();
    mount(
      <DataTable
        columns={COLUMNS}
        rows={[]}
        getRowKey={(row) => row.id}
        loading
        error="请求超时"
        onRetry={onRetry}
      />,
    );
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("请求超时");
    expect(document.querySelector("table")).toBeNull();

    const retry = Array.from(document.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "重试",
    );
    act(() => {
      retry?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("errorSlot 优先于 error 文案；error 为空串/null 时不算错误", () => {
    mount(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={(row) => row.id}
        error="被忽略"
        errorSlot={<div data-slot="custom-error">自定义错误</div>}
      />,
    );
    expect(document.querySelector('[data-slot="custom-error"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain("被忽略");

    mount(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={(row) => row.id}
        error=""
      />,
    );
    expect(document.querySelector("table")).not.toBeNull();
  });

  it("分页插槽渲染在表格下方（PaginationBar 正常显示）", () => {
    mount(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={(row) => row.id}
        paginationSlot={
          <PaginationBar
            page={2}
            pageSize={10}
            total={30}
            onPageChange={() => {}}
          />
        }
      />,
    );
    expect(document.querySelector("table")).not.toBeNull();
    expect(document.body.textContent).toContain("第 11–20 条 / 共 30 条");
  });

  it("caption 生成 sr-only 表格标题（列表页无障碍）", () => {
    mount(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={(row) => row.id}
        caption="单证列表"
      />,
    );
    const caption = document.querySelector("caption");
    expect(caption?.textContent).toBe("单证列表");
    expect(caption?.className).toContain("sr-only");
  });
});
