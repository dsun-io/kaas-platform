/**
 * 条款模板设置卡片（A5-W1）—— 无后端组件测试。
 *
 * 覆盖：
 * 1. 列表渲染（名称 / 适用单证中文标签 / 中英摘要）；
 * 2. 新建：POST body 形状（含 doc_types 多选）、成功后提示；
 * 3. 403（非团队管理员）→ 后端 message 如实透出、弹窗不关闭；
 * 4. 删除二次确认 → 确认后 DELETE 正确路径；
 * 5. 只读账号（canWrite=false）→ 无写入口 + 只读提示；
 * 6. 422 → detail/code 透出。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ClauseTemplatesCard } from "../clause-templates-card";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({
  default: {
    get: mocks.get,
    post: mocks.post,
    patch: mocks.patch,
    delete: mocks.delete,
  },
  apiClient: {
    get: mocks.get,
    post: mocks.post,
    patch: mocks.patch,
    delete: mocks.delete,
  },
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TEMPLATES = [
  {
    id: 1,
    name: "T/T 30% 定金条款",
    doc_types: ["pi", "contract"],
    text_zh: "30% 定金，余款凭提单副本支付。",
    text_en: "30% deposit, balance against B/L copy.",
    sort_order: 10,
    is_active: true,
  },
  {
    id: 2,
    name: "通用声明",
    doc_types: ["contract"],
    text_zh: "兹证明本单据内容真实。",
    text_en: "We certify the contents are true.",
    sort_order: 20,
    is_active: true,
  },
];

type Resp = { data: unknown };
const ok = (data: unknown): Resp => ({ data }) as unknown as Resp;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

async function settle(times = 4) {
  await act(async () => {
    for (let i = 0; i < times; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

function mount(element: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  root = createRoot(container);
  act(() => {
    root!.render(
      <QueryClientProvider client={client!}>{element}</QueryClientProvider>,
    );
  });
}

function unmount() {
  if (root) act(() => root!.unmount());
  container?.remove();
  client?.clear();
  root = null;
  container = null;
  client = null;
}

function clickButton(text: string, scope: ParentNode = document) {
  const buttons = Array.from(scope.querySelectorAll("button"));
  const target = buttons.find(
    (b) => b.textContent?.replace("…", "").trim() === text,
  );
  if (!target) throw new Error(`没找到按钮「${text}」`);
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** 勾选一个适用单证（后端要求 doc_types 非空，表单提交前必须先勾） */
function checkDocType(labelText: string) {
  const checkbox = Array.from(
    document.querySelectorAll<HTMLLabelElement>("label"),
  )
    .find((l) => l.textContent?.trim() === labelText)
    ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!checkbox) throw new Error(`没找到单证类型「${labelText}」`);
  act(() => {
    checkbox.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue(ok({ items: TEMPLATES }));
});

afterEach(() => {
  unmount();
  document.body.innerHTML = "";
});

describe("ClauseTemplatesCard", () => {
  it("列表渲染名称、适用单证中文标签与中英摘要", async () => {
    mount(<ClauseTemplatesCard canWrite />);
    await settle();
    const text = document.body.textContent ?? "";
    expect(text).toContain("条款模板");
    expect(text).toContain("T/T 30% 定金条款");
    // doc_types: pi→形式发票, contract→销售合同（后端要求非空 18 类子集）
    expect(text).toContain("形式发票");
    expect(text).toContain("销售合同");
    expect(text).toContain("30% deposit");
    expect(mocks.get.mock.calls[0]?.[0]).toBe("/clause-templates");
  });

  it("新建：POST body 含 doc_types 多选与双语内容，成功后提示", async () => {
    mocks.post.mockResolvedValue(
      ok({ ...TEMPLATES[0], id: 9, name: "新模板" }),
    );
    mount(<ClauseTemplatesCard canWrite />);
    await settle();

    clickButton("新建模板");
    await settle();

    const nameInput = document.querySelector<HTMLInputElement>(
      'input[placeholder="例如：T/T 30% 定金条款"]',
    );
    expect(nameInput).not.toBeNull();
    setValue(nameInput!, "新模板");
    const textareas = Array.from(
      document.querySelectorAll<HTMLTextAreaElement>("textarea"),
    );
    expect(textareas.length).toBeGreaterThanOrEqual(2);
    setValue(textareas[0]!, "中文条款内容");
    setValue(textareas[1]!, "English clause text");
    // 勾选一个适用单证（形式发票）
    const piCheckbox = Array.from(
      document.querySelectorAll<HTMLLabelElement>("label"),
    )
      .find((l) => l.textContent?.trim() === "形式发票")
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(piCheckbox).not.toBeNull();
    act(() => {
      piCheckbox!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    clickButton("创建模板");
    await settle();

    expect(mocks.post).toHaveBeenCalledTimes(1);
    const [url, body] = mocks.post.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe("/clause-templates");
    expect(body).toMatchObject({
      name: "新模板",
      text_zh: "中文条款内容",
      text_en: "English clause text",
      sort_order: 0,
    });
    expect(body.doc_types).toContain("pi");
    expect(toastSuccess).toHaveBeenCalledWith("条款模板已创建");
  });

  it("403：后端 message 如实透出，弹窗保留可改", async () => {
    mocks.post.mockRejectedValue({
      response: {
        status: 403,
        data: {
          detail: {
            error: "forbidden",
            code: "FORBIDDEN",
            message: "仅团队管理员可管理条款模板",
          },
        },
      },
    });
    mount(<ClauseTemplatesCard canWrite />);
    await settle();
    clickButton("新建模板");
    await settle();

    const nameInput = document.querySelector<HTMLInputElement>(
      'input[placeholder="例如：T/T 30% 定金条款"]',
    );
    setValue(nameInput!, "无权限模板");
    const textareas = Array.from(
      document.querySelectorAll<HTMLTextAreaElement>("textarea"),
    );
    setValue(textareas[0]!, "内容");
    checkDocType("形式发票");
    clickButton("创建模板");
    await settle();

    const text = document.body.textContent ?? "";
    expect(text).toContain("仅团队管理员可管理条款模板");
    expect(text).toContain("保存修改".replace("保存修改", "创建模板"));
  });

  it("422：字段级 detail/code 透出", async () => {
    mocks.post.mockRejectedValue({
      response: {
        status: 422,
        data: {
          detail: {
            error: "validation",
            code: "CLAUSE_TEXT_REQUIRED",
            detail: "中文或英文条款内容至少填一项",
          },
        },
      },
    });
    mount(<ClauseTemplatesCard canWrite />);
    await settle();
    clickButton("新建模板");
    await settle();
    const nameInput = document.querySelector<HTMLInputElement>(
      'input[placeholder="例如：T/T 30% 定金条款"]',
    );
    setValue(nameInput!, "只有名字");
    clickButton("创建模板");
    await settle();
    // 前端先本地校验：内容为空 → 不发请求
    expect(mocks.post).not.toHaveBeenCalled();
    expect(document.body.textContent ?? "").toContain("中文或英文内容至少填一项");

    // 填了内容后由后端 422 拦（覆盖 detail 透出路径）
    const textareas = Array.from(
      document.querySelectorAll<HTMLTextAreaElement>("textarea"),
    );
    setValue(textareas[0]!, "内容");
    checkDocType("形式发票");
    clickButton("创建模板");
    await settle();
    expect(document.body.textContent ?? "").toContain(
      "中文或英文条款内容至少填一项",
    );
  });

  it("删除需二次确认：确认后 DELETE 正确路径", async () => {
    mocks.delete.mockResolvedValue(ok({ id: 1, is_active: false }));
    mount(<ClauseTemplatesCard canWrite />);
    await settle();

    const del = document.querySelector<HTMLButtonElement>(
      'button[aria-label="删除条款模板 T/T 30% 定金条款"]',
    );
    expect(del).not.toBeNull();
    act(() => {
      del!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(document.body.textContent ?? "").toContain("删除条款模板？");

    clickButton("确认删除");
    await settle();
    expect(mocks.delete).toHaveBeenCalledWith("/clause-templates/1");
    expect(toastSuccess).toHaveBeenCalledWith("条款模板已删除");
  });

  it("只读账号：无新建/编辑/删除入口，显示只读提示", async () => {
    mount(<ClauseTemplatesCard canWrite={false} />);
    await settle();
    const text = document.body.textContent ?? "";
    expect(text).toContain("只能查看条款模板");
    expect(text).not.toContain("新建模板");
    expect(
      document.querySelector('button[aria-label^="删除条款模板"]'),
    ).toBeNull();
  });
});
