// @vitest-environment node
/**
 * A7 单证加固 MSW 契约测试（fact / consistency / lint / receipts / doc-set）
 *
 * 目的与 `p1-handlers-contract.test.ts` 同口径：`onUnhandledRequest: "error"`
 * ⇒ 拿到 200/201 本身就证明"这个端点有 handler、没放行到网络"；随后断言**形状**
 * 与 `backend/worker/src/ws_docs_hardening.py` 逐字段对齐（前端真实读的那几个键）。
 *
 * 这里还覆盖两条**联动**（比单端点形状更容易悄悄坏）：
 * - 未确认事实 ⇒ `PATCH /trade-docs/{id}` 签发 422 + `detail.blocking`；确认后同一请求 200；
 * - `PUT doc-set` 全量替换**保留已登记回执**（后端 upsert 语义，mock 必须一致）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupServer } from "msw/node";

import { handlers, resetMockData } from "../handlers";

const server = setupServer(...handlers);
const ORIGIN = "http://localhost:3000";
const BASE = `${ORIGIN}/api/v1`;
const JSON_HEADERS = { "Content-Type": "application/json" };

beforeAll(() => {
  Object.defineProperty(globalThis, "location", {
    value: { href: `${ORIGIN}/` },
    configurable: true,
  });
  server.listen({ onUnhandledRequest: "error" });
});
afterAll(() => server.close());
beforeEach(() => resetMockData());

async function getJson<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: (await res.json()) as T };
}

async function sendJson<T>(
  path: string,
  method: "POST" | "PATCH" | "PUT",
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: JSON_HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

type Fact = {
  key: string;
  value: string;
  trust: string;
  source: string | null;
  immutable: boolean;
  text_zh: string | null;
  text_en: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  evidence_ref: string | null;
  currency: string | null;
};
type Summary = {
  total: number;
  confirmed: number;
  unverified: number;
  inferred: number;
};
type ErrorBody = { detail: { error: string; code: string; detail: string } };

describe("GET /trade-docs/:id/facts —— 事实清单 + summary", () => {
  it("形状照 _fact_dict + _summary；付款条款是待确认", async () => {
    const { status, body } = await getJson<{
      doc_id: number;
      doc_type: string;
      doc_no: string;
      status: string;
      items: Fact[];
      summary: Summary;
    }>("/trade-docs/1/facts");

    expect(status).toBe(200);
    expect(body.doc_id).toBe(1);
    expect(body.doc_no).toBe("PI-202610-0001");
    expect(body.summary.total).toBe(body.items.length);
    expect(body.summary.unverified).toBeGreaterThan(0);

    const payment = body.items.find((item) => item.key === "payment_terms");
    expect(payment).toBeTruthy();
    expect(payment?.trust).toBe("unverified");
    // 内核 `_fact_dict` 的逐字段（缺一个编辑器就会"打开即丢数据"）
    for (const key of [
      "key",
      "value",
      "trust",
      "source",
      "immutable",
      "text_zh",
      "text_en",
      "confirmed_by",
      "confirmed_at",
      "evidence_ref",
      "currency",
    ]) {
      expect(payment).toHaveProperty(key);
    }
  });
});

describe("POST /trade-docs/:id/facts/confirm —— 确认回写是签发的前提", () => {
  it("确认前签发 422 FACT_UNVERIFIED；全部确认后 summary 变化且签发 200", async () => {
    const blocked = await sendJson<{
      detail: {
        code: string;
        blocking: Array<{ code: string; keys?: string[]; detail: string }>;
      };
    }>("/trade-docs/3", "PATCH", { status: "issued" });
    expect(blocked.status).toBe(422);
    expect(blocked.body.detail.code).toBe("FACT_UNVERIFIED");
    expect(blocked.body.detail.blocking.length).toBeGreaterThan(0);
    expect(blocked.body.detail.blocking[0]?.code).toBe("FACT_UNVERIFIED");
    expect(blocked.body.detail.blocking[0]?.keys?.length).toBeGreaterThan(0);

    const before = await getJson<{ summary: Summary }>("/trade-docs/3/facts");
    const confirmed = await sendJson<{
      confirmed: string[];
      summary: Summary;
    }>("/trade-docs/3/facts/confirm", "POST", { keys: [] });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.confirmed.length).toBeGreaterThan(0);
    expect(confirmed.body.summary.unverified).toBe(0);
    expect(confirmed.body.summary.confirmed).toBeGreaterThan(
      before.body.summary.confirmed,
    );

    const issued = await sendJson<Record<string, unknown>>(
      "/trade-docs/3",
      "PATCH",
      { status: "issued" },
    );
    expect(issued.status).toBe(200);
  });

  it("未知事实键 422 FACT_KEY_UNKNOWN", async () => {
    const res = await sendJson<ErrorBody>(
      "/trade-docs/1/facts/confirm",
      "POST",
      { keys: ["no_such_fact"] },
    );
    expect(res.status).toBe(422);
    expect(res.body.detail.code).toBe("FACT_KEY_UNKNOWN");
  });
});

describe("PATCH /trade-docs/:id/facts/:factKey —— 只改处置，不改值", () => {
  it("改 value 一律 422（值的唯一真源是 payload）", async () => {
    const res = await sendJson<ErrorBody>(
      "/trade-docs/1/facts/payment_terms",
      "PATCH",
      { value: "0" },
    );
    expect(res.status).toBe(422);
    expect(res.body.detail.code).toBe("FACT_VALUE_IMMUTABLE_STORAGE");
  });

  it("未知 fact_key 404；改双语/证据 200 且逐字段回显", async () => {
    const missing = await sendJson<ErrorBody>(
      "/trade-docs/1/facts/not_exists",
      "PATCH",
      { text_zh: "x" },
    );
    expect(missing.status).toBe(404);
    expect(missing.body.detail.code).toBe("FACT_NOT_FOUND");

    const patched = await sendJson<{ item: Fact }>(
      "/trade-docs/1/facts/incoterm",
      "PATCH",
      { text_zh: "FOB 宁波", text_en: "FOB Ningbo", evidence_ref: "合同第 3 条" },
    );
    expect(patched.status).toBe(200);
    expect(patched.body.item.text_zh).toBe("FOB 宁波");
    expect(patched.body.item.text_en).toBe("FOB Ningbo");
    expect(patched.body.item.evidence_ref).toBe("合同第 3 条");
  });
});

describe("GET /trade-docs/:id/consistency —— 冲突/等价措辞/缺失三档", () => {
  it("三档同时出现，severity 与 status 一一对应", async () => {
    const { status, body } = await getJson<{
      ok: boolean;
      domain: { root: string; doc_ids: string[] };
      items: Array<{
        severity: string;
        code: string;
        key: string;
        status: string;
        baseline_doc: string;
        values: Record<string, string>;
        detail: string;
      }>;
    }>("/trade-docs/2/consistency");

    expect(status).toBe(200);
    expect(body.domain.root).toBe("order:9");
    expect(body.ok).toBe(false);

    const byStatus = new Map(body.items.map((item) => [item.status, item]));
    expect(byStatus.get("conflict")?.severity).toBe("error");
    expect(byStatus.get("conflict")?.code).toBe("FACT_CONFLICT");
    expect(byStatus.get("conflict")?.key).toBe("total_amount");
    expect(byStatus.get("equivalent")?.severity).toBe("warning");
    expect(byStatus.get("equivalent")?.code).toBe("FACT_EQUIVALENT_WORDING");
    // 缺失只报**不可改写**的基线事实（内核 lint_pair：派生单不必须携带每条基线事实），
    // 且后端把它标成 error（承继核对结论），所以这里断言 status/code 而不依赖 severity。
    expect(byStatus.get("missing")?.code).toBe("FACT_MISSING");
    expect(byStatus.get("missing")?.key).toBe("incoterm");

    // values 是 `{doc_id: 值}`：冲突项必须两边都有值
    const conflict = byStatus.get("conflict");
    expect(Object.keys(conflict?.values ?? {})).toHaveLength(2);
    expect(conflict?.baseline_doc).toBe("1");
  });
});

describe("POST /trade-docs/:id/lint —— blocking 红 / warnings 黄", () => {
  it("未确认事实进 blocking，金额推导进 warnings", async () => {
    const { status, body } = await sendJson<{
      ok: boolean;
      blocking: Array<{ code: string; keys?: string[]; detail: string }>;
      warnings: Array<{ code: string; key?: string; detail: string }>;
      summary: { blocking: number; warnings: number; facts: Summary };
    }>("/trade-docs/1/lint", "POST");

    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.blocking.some((item) => item.code === "FACT_UNVERIFIED")).toBe(
      true,
    );
    expect(body.warnings.length).toBeGreaterThan(0);
    expect(body.summary.blocking).toBe(body.blocking.length);
    expect(body.summary.warnings).toBe(body.warnings.length);
    expect(body.summary.facts.total).toBeGreaterThan(0);
  });
});

describe("GET/POST /trade-docs/:id/receipts —— 核销三档", () => {
  it("列表里三档徽标数据齐（fx_rounding / short_paid / manual）", async () => {
    const { status, body } = await getJson<{
      total: number;
      items: Array<{
        diff_reason: string;
        status: string;
        received_amount: string;
        currency: string;
        diff: string;
      }>;
    }>("/trade-docs/1/receipts");

    expect(status).toBe(200);
    expect(body.total).toBe(3);
    const reasons = body.items.map((item) => item.diff_reason);
    expect(reasons).toContain("fx_rounding");
    expect(reasons).toContain("short_paid");
    // 金额是 decimal 文本（字符串），前端不 parseFloat 再格式化
    expect(typeof body.items[0]?.received_amount).toBe("string");
  });

  it("容差内自动核销 / 超容差短收 / 无账期 manual / 非法币种 422", async () => {
    const fx = await sendJson<{
      item: { status: string; diff: string };
      verdict: { auto_cleared: boolean; diff_reason: string; tolerance: string };
    }>("/trade-docs/1/receipts", "POST", {
      schedule_type: "deposit",
      schedule_amount: "1000",
      received_amount: "999.99",
      currency: "USD",
    });
    expect(fx.status).toBe(201);
    expect(fx.body.verdict.auto_cleared).toBe(true);
    expect(fx.body.verdict.diff_reason).toBe("fx_rounding");
    expect(fx.body.item.status).toBe("reconciled");

    const short = await sendJson<{
      item: { status: string };
      verdict: { auto_cleared: boolean; diff_reason: string };
    }>("/trade-docs/1/receipts", "POST", {
      schedule_type: "balance",
      schedule_amount: "5000",
      received_amount: "4000",
      currency: "USD",
    });
    expect(short.status).toBe(201);
    expect(short.body.verdict.auto_cleared).toBe(false);
    expect(short.body.verdict.diff_reason).toBe("short_paid");
    expect(short.body.item.status).toBe("short_paid");

    const manual = await sendJson<{
      item: { status: string };
      verdict: { diff_reason: string };
    }>("/trade-docs/1/receipts", "POST", {
      received_amount: "100",
      currency: "USD",
    });
    expect(manual.status).toBe(201);
    expect(manual.body.verdict.diff_reason).toBe("manual");
    expect(manual.body.item.status).toBe("manual");

    const badCurrency = await sendJson<ErrorBody>(
      "/trade-docs/1/receipts",
      "POST",
      { received_amount: "1", currency: "XYZ" },
    );
    expect(badCurrency.status).toBe(422);
    expect(badCurrency.body.detail.code).toBe("INVALID_ENUM");
  });
});

describe("GET/PUT doc-set + 回执登记", () => {
  it("清单形状 + not_by_us 回执 receive / 非法转移 409", async () => {
    const list = await getJson<{
      total: number;
      items: Array<{
        doc_type: string;
        role: string;
        issuer: string;
        status: string;
        evidence_required: boolean;
        waived_reason: string | null;
        received_doc_id: number | null;
        received_at: string | null;
      }>;
    }>("/trade-docs/1/doc-set");
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(2);
    const co = list.body.items.find((item) => item.doc_type === "co");
    expect(co?.role).toBe("not_by_us");
    expect(co?.status).toBe("pending");
    for (const key of [
      "doc_type",
      "role",
      "issuer",
      "trigger_expr",
      "evidence_required",
      "status",
      "waived_reason",
      "received_doc_id",
      "received_at",
    ]) {
      expect(co).toHaveProperty(key);
    }

    const received = await sendJson<{ item: { status: string } }>(
      "/trade-docs/1/doc-set/co/receipt",
      "POST",
      { action: "receive", received_doc_id: 2 },
    );
    expect(received.status).toBe(200);
    expect(received.body.item.status).toBe("received");

    const again = await sendJson<ErrorBody>(
      "/trade-docs/1/doc-set/co/receipt",
      "POST",
      { action: "waive", waived_reason: "重复登记" },
    );
    expect(again.status).toBe(409);
    expect(again.body.detail.code).toBe("ILLEGAL_DOC_SET_TRANSITION");
  });

  it("豁免必须填原因；填了就是 waived", async () => {
    const noReason = await sendJson<ErrorBody>(
      "/trade-docs/1/doc-set/co/receipt",
      "POST",
      { action: "waive" },
    );
    expect(noReason.status).toBe(422);
    expect(noReason.body.detail.code).toBe("DOC_SET_INVALID");

    const waived = await sendJson<{ item: { status: string; waived_reason: string } }>(
      "/trade-docs/1/doc-set/co/receipt",
      "POST",
      { action: "waive", waived_reason: "客户自办产地证" },
    );
    expect(waived.status).toBe(200);
    expect(waived.body.item.status).toBe("waived");
    expect(waived.body.item.waived_reason).toBe("客户自办产地证");
  });

  it("PUT 全量替换保留已登记回执；重复 doc_type 409", async () => {
    await sendJson("/trade-docs/1/doc-set/co/receipt", "POST", {
      action: "receive",
      received_doc_id: 2,
    });

    const put = await sendJson<{
      items: Array<{ doc_type: string; status: string; role: string }>;
    }>("/trade-docs/1/doc-set", "PUT", {
      items: [
        { doc_type: "co", role: "not_by_us", issuer: "third_party:ccpit" },
        { doc_type: "pl", role: "required", issuer: "ours" },
      ],
    });
    expect(put.status).toBe(200);
    const co = put.body.items.find((item) => item.doc_type === "co");
    // 后端 upsert 语义：改清单不能把已登记的回执抹掉（数据丢失）
    expect(co?.status).toBe("received");

    const duplicate = await sendJson<ErrorBody>(
      "/trade-docs/1/doc-set",
      "PUT",
      {
        items: [
          { doc_type: "pl", role: "required", issuer: "ours" },
          { doc_type: "pl", role: "optional", issuer: "ours" },
        ],
      },
    );
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.detail.code).toBe("DOC_SET_DUPLICATE");
  });
});
