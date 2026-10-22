// @vitest-environment node
/**
 * P1 组 MSW handler 回归（对齐修复 B · 2026-10-20）
 *
 * 这些端点原先**没有 handler**（`.tmp/msw-diff.txt`）⇒ mock 模式下
 * `onUnhandledRequest:"warn"` 放行到网络 ⇒ 本地无后端时挂起/失败 ⇒ 页面静默空白。
 *
 * 本文件与 `write-handlers-contract.test.ts` 同口径：`setupServer` +
 * **`onUnhandledRequest: "error"`** —— 只要有一个端点没被 handler 接住，请求就会以
 * `Cannot bypass a request when using the error strategy` 失败。
 * 所以"拿到 200/201"本身就是"没有放行到网络"的证明。
 *
 * 第二个断言目标是**形状**：每个 describe 上方标了 shape 真源（worker 的
 * `row_to_*` / `_*_out`），断言的就是前端真实读的那几个键。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupServer } from "msw/node";

import { handlers, resetMockData } from "../handlers";

const server = setupServer(...handlers);
const ORIGIN = "http://localhost:3000";
const BASE = `${ORIGIN}/api/v1`;
const JSON_HEADERS = { "Content-Type": "application/json" };

beforeAll(() => {
  // MSW 在 Node 里 `normalizePath()` 要用 `location.href` 解析**相对** handler 路径
  // （`msw/lib/core/utils/url/getAbsoluteUrl.mjs:9`）；浏览器由 document.baseURI 提供，
  // Node 里没有 ⇒ 相对路径匹配不上（所有请求都会被判未处理）。补一个最小 origin。
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
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: JSON_HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: (text ? JSON.parse(text) : null) as T,
  };
}

/** 1×1 透明 PNG（与 handlers 里的 MOCK_PNG_BYTES 同值；公章校验只认 PNG 魔数） */
const PNG_BYTES = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0,
  0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 10, 73, 68, 65, 84, 120,
  156, 99, 0, 1, 0, 0, 5, 0, 1, 13, 10, 45, 180, 0, 0, 0, 0, 73, 69, 78, 68,
  174, 66, 96, 130,
]);

/**
 * 本文件跑在 **node 环境**（`@vitest-environment node`）。
 *
 * 原因：multipart 上传要用 `FormData`/`File` + `fetch`。jsdom 环境把这两个全局换成
 * jsdom 实现，而 `fetch` 是 Node(undici) 的 —— 品牌不互认，multipart 在
 * `request.formData()` 里直接 assert 失败（或请求挂起到超时）。handlers 本身是
 * 纯请求/响应逻辑、不碰 DOM，所以 node 环境既能测到真实 multipart 解析、又更接近
 * 浏览器里 axios 发出的那份字节流。
 */
function pngFile(name: string): File {
  return new File([PNG_BYTES], name, { type: "image/png" });
}

function postForm(
  path: string,
  build: (form: FormData) => void,
): Promise<Response> {
  const form = new FormData();
  build(form);
  // 不手写 Content-Type：让 fetch 自己带 multipart boundary
  return fetch(`${BASE}${path}`, { method: "POST", body: form });
}

// ── 单证：列表字段（A8/A9）+ 指纹对账 + 上游刷新 + 文件版本链 ───────────────

describe("GET /trade-docs ← use-trade-docs.ts:111（列表列配置/A8/A9 标识）", () => {
  it("每行带 doc_no_editable + render_check；三种故事可区分", async () => {
    const { status, body } = await getJson<{
      items: Array<{
        id: number;
        doc_no_editable: boolean;
        render_check: {
          matches: boolean;
          reason: string;
          render_version_drift: boolean;
          checked_at: string | null;
        } | null;
      }>;
      total: number;
    }>("/trade-docs");

    expect(status).toBe(200);
    expect(body.total).toBe(4);

    const byId = new Map(body.items.map((d) => [d.id, d]));
    // 已变更（data_changed）：matches=false，界面显示红标
    expect(byId.get(1)?.render_check?.reason).toBe("data_changed");
    expect(byId.get(1)?.render_check?.matches).toBe(false);
    // 模板已更新（version_drift）：摘要一致但版本漂移
    expect(byId.get(2)?.render_check?.reason).toBe("version_drift");
    expect(byId.get(2)?.render_check?.render_version_drift).toBe(true);
    // 从未对账 ⇒ null（界面不显示任何标识，不冒充"没问题"）
    expect(byId.get(3)?.render_check).toBeNull();
    // 一致 ⇒ 也不显示标识
    expect(byId.get(4)?.render_check?.reason).toBe("matched");

    // doc_no_editable：id 1、2 同属 order 9，id 1 后面还有 id 2 ⇒ 号码锁定
    expect(byId.get(1)?.doc_no_editable).toBe(false);
    expect(byId.get(2)?.doc_no_editable).toBe(true);
  });
});

describe("GET /trade-docs/:id/render-fingerprint-check ← use-trade-docs.ts:434", () => {
  it("11 字段与内核同形；data_changed / no_fingerprint 两种结论", async () => {
    const changed = await getJson<Record<string, unknown>>(
      "/trade-docs/1/render-fingerprint-check",
    );
    expect(changed.status).toBe(200);
    for (const key of [
      "has_fingerprint",
      "frozen",
      "current_sha256",
      "matches",
      "render_version_frozen",
      "render_version_current",
      "render_version_drift",
      "reason",
      "checked_at",
      "current_note",
      "frozen_note",
    ]) {
      expect(changed.body, `缺字段 ${key}`).toHaveProperty(key);
    }
    expect(changed.body.has_fingerprint).toBe(true);
    expect(changed.body.matches).toBe(false);
    expect(changed.body.reason).toBe("data_changed");

    const draft = await getJson<Record<string, unknown>>(
      "/trade-docs/3/render-fingerprint-check",
    );
    expect(draft.body.has_fingerprint).toBe(false);
    expect(draft.body.reason).toBe("no_fingerprint");
  });
});

describe("POST /trade-docs/:id/refresh-sources ← use-trade-docs.ts:207", () => {
  it("draft + 有上游 ⇒ 200 `{doc,sources}`；已签发 409；无上游 422", async () => {
    const ok = await sendJson<{
      doc: { raw_payload: unknown };
      sources: string[];
    }>("/trade-docs/4/refresh-sources", "POST");
    expect(ok.status).toBe(200);
    expect(ok.body.sources).toEqual(["quote"]);

    const issued = await sendJson<unknown>(
      "/trade-docs/1/refresh-sources",
      "POST",
    );
    expect(issued.status).toBe(409);

    const noUpstream = await sendJson<unknown>(
      "/trade-docs/3/refresh-sources",
      "POST",
    );
    expect(noUpstream.status).toBe(422);
  });
});

describe("单证文件版本链 ← use-trade-docs.ts:319 / :340（上传 / 解绑）", () => {
  it("上传 201 后列表能看到；解绑 204 后为空", async () => {
    const res = await postForm("/trade-docs/3/files/upload", (form) => {
      form.append("file", pngFile("stamp.png"));
      form.append("role", "stamp_scan");
      form.append("name", "客户盖章回传");
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      file: { id: number; name: string; content_type: string };
      link: { id: number; role: string };
    };
    expect(created.file.name).toBe("客户盖章回传");
    expect(created.link.role).toBe("stamp_scan");

    const listed = await getJson<{
      items: Array<{
        id: number;
        link_id: number;
        role: string;
        is_current: boolean;
      }>;
    }>("/trade-docs/3/files");
    expect(listed.body.items.length).toBe(1);
    expect(listed.body.items[0]?.link_id).toBe(created.link.id);

    const removed = await sendJson<unknown>(
      `/trade-docs/3/files/${created.link.id}`,
      "DELETE",
    );
    expect(removed.status).toBe(204);
    const after = await getJson<{ items: unknown[] }>("/trade-docs/3/files");
    expect(after.body.items).toEqual([]);
  });
});

// ── 客户：询盘（含 F4 stage / stage-log）与联系人 ───────────────────────────

describe("GET /customers/:id/inquiries ← quotes/views（F4 真值来源）", () => {
  it("`{items,total}` + inquiry_no/stage/stage_updated_at + inquiry_no_editable", async () => {
    const { status, body } = await getJson<{
      items: Array<{
        id: number;
        inquiry_no: string | null;
        stage: string | null;
        stage_updated_at: string | null;
        inquiry_no_editable: boolean;
      }>;
      total: number;
    }>("/customers/1/inquiries");

    expect(status).toBe(200);
    expect(body.total).toBe(1);
    const inquiry = body.items[0];
    expect(inquiry?.inquiry_no).toBeTruthy();
    // 后端 customer_serializers.py:75-76 的 F4 字段（缺了客户页就只能退回本地推导）
    expect(inquiry?.stage).toBe("quotation");
    expect(typeof inquiry?.stage_updated_at).toBe("string");
    // 客户 1 的询盘已挂报价单 ⇒ 编号锁定（worker 有意差异 inquiry_no_editable）
    expect(inquiry?.inquiry_no_editable).toBe(false);

    const unknown = await getJson<unknown>("/customers/999/inquiries");
    expect(unknown.status).toBe(404);
  });
});

describe("PATCH /inquiries/:id ← customers/page.tsx:899/:917", () => {
  it("关闭询盘：200 + stage 变 closed + stage-log 多一条；重开回到未报价", async () => {
    // 客户 2 的询盘没有报价单（不受编号锁定约束），用它验证状态流转
    const detail = await getJson<{
      inquiries: Array<{ id: number; status: string }>;
    }>("/customers/2");
    const inquiryId = detail.body.inquiries[0]?.id;
    expect(inquiryId).toBeDefined();
    expect(detail.body.inquiries[0]?.status).toBe("quoted");

    const close = await sendJson<{ status: string; stage: string }>(
      `/inquiries/${inquiryId}`,
      "PATCH",
      { status: "closed" },
    );
    expect(close.status).toBe(200);
    expect(close.body.status).toBe("closed");
    expect(close.body.stage).toBe("closed");

    const log = await getJson<{
      items: Array<{
        from_stage: string | null;
        to_stage: string;
        source_event: string;
      }>;
    }>(`/inquiries/${inquiryId}/stage-log`);
    expect(log.status).toBe(200);
    expect(log.body.items.length).toBe(2); // 种子一条 + 本次关闭一条
    expect(log.body.items[1]?.to_stage).toBe("closed");
    expect(log.body.items[1]?.source_event).toBe("inquiry_closed");

    const reopen = await sendJson<{ status: string }>(
      `/inquiries/${inquiryId}`,
      "PATCH",
      { status: "unquoted" },
    );
    expect(reopen.status).toBe(200);
    expect(reopen.body.status).toBe("unquoted");
  });

  it("已挂报价的询盘改编号 ⇒ 409 INQUIRY_NO_LOCKED", async () => {
    // 客户 1 的询盘在种子数据里已挂报价单；`inquiry_no_editable` 由**列表**端点计算
    // （worker 的 detail 不带它，见 ws_crm_ext.py:249-257 与 row_to_inquiry 的差异）
    const list = await getJson<{
      items: Array<{ id: number; inquiry_no_editable: boolean }>;
    }>("/customers/1/inquiries");
    const inquiryId = list.body.items[0]?.id;
    expect(list.body.items[0]?.inquiry_no_editable).toBe(false);

    const res = await sendJson<{ detail: { code: string } }>(
      `/inquiries/${inquiryId}`,
      "PATCH",
      { inquiry_no: "NEW-NO" },
    );
    expect(res.status).toBe(409);
    expect(res.body.detail.code).toBe("INQUIRY_NO_LOCKED");
  });

  it("非法流转（quoted → unquoted，无报价可回退）⇒ 409 ILLEGAL_TRANSITION", async () => {
    const detail = await getJson<{ inquiries: Array<{ id: number }> }>(
      "/customers/2",
    );
    const res = await sendJson<{ detail: { code: string } }>(
      `/inquiries/${detail.body.inquiries[0]?.id}`,
      "PATCH",
      { status: "unquoted" },
    );
    expect(res.status).toBe(409);
    expect(res.body.detail.code).toBe("ILLEGAL_TRANSITION");
  });
});

describe("联系人更新/删除 ← customers/page.tsx:554/:928", () => {
  it("PATCH 返 7 键投影；DELETE 204 且详情里真的少一条", async () => {
    const detail = await getJson<{
      contacts: Array<{ id: number; name: string }>;
    }>("/customers/1");
    const first = detail.body.contacts[0];
    expect(first).toBeDefined();

    const patched = await sendJson<Record<string, unknown>>(
      `/customers/1/contacts/${first?.id}`,
      "PATCH",
      { name: "王经理（改）", phone: "123" },
    );
    expect(patched.status).toBe(200);
    expect(patched.body.name).toBe("王经理（改）");
    // `_contact_api` 是 7 键投影，不含 created_at（main.py:1468-1475）
    expect(Object.keys(patched.body).sort()).toEqual([
      "email",
      "id",
      "is_primary",
      "name",
      "phone",
      "position",
      "whatsapp",
    ]);

    const removed = await sendJson<unknown>(
      `/customers/1/contacts/${first?.id}`,
      "DELETE",
    );
    expect(removed.status).toBe(204);
    const after = await getJson<{ contacts: unknown[] }>("/customers/1");
    expect(after.body.contacts.length).toBe(detail.body.contacts.length - 1);
  });
});

// ── 产品 / 产品图 / 文件对象 ────────────────────────────────────────────────

describe("GET /products 与 profile ← lib/products/use-products.ts", () => {
  it("列表 3 个注册表产品 + media_kinds；profile 读写回环", async () => {
    const list = await getJson<{
      items: Array<{ product_key: string; name: string; media_count: number }>;
      media_kinds: Record<string, string>;
    }>("/products");
    expect(list.status).toBe(200);
    expect(list.body.items.map((p) => p.product_key).sort()).toEqual([
      "chain_link",
      "deer_net",
      "field_fence",
    ]);
    expect(list.body.media_kinds.production).toBe("生产图片");

    const saved = await sendJson<{
      product_key: string;
      info: Record<string, unknown>;
    }>("/products/field_fence/profile", "PUT", { info: { moq: 100 } });
    expect(saved.status).toBe(200);
    const read = await getJson<{ info: Record<string, unknown> }>(
      "/products/field_fence/profile",
    );
    expect(read.body.info).toEqual({ moq: 100 });
  });
});

describe("产品图与 file-objects ← use-products.ts:147/:208/:269/:315", () => {
  it("上传 → 列表 → 取字节 → 改名/排序 → 退役", async () => {
    const uploaded = await postForm("/products/field_fence/media", (form) => {
      form.append("file", pngFile("photo.png"));
      form.append("name", "主图");
      form.append("media_kind", "production");
    });
    expect(uploaded.status).toBe(201);
    const media = (await uploaded.json()) as { id: number; name: string };

    const listed = await getJson<{
      items: Array<{ id: number; name: string }>;
    }>("/products/field_fence/media");
    expect(listed.body.items.length).toBe(1);

    const content = await fetch(`${BASE}/file-objects/${media.id}/content`);
    expect(content.status).toBe(200);
    expect(content.headers.get("content-type")).toBe("image/png");

    const url = await getJson<{ configured: boolean }>(
      `/file-objects/${media.id}/url`,
    );
    expect(url.body.configured).toBe(false);

    const patched = await sendJson<{ ok: boolean }>(
      `/file-objects/${media.id}`,
      "PATCH",
      { name: "改名", sort_order: 2 },
    );
    expect(patched.body.ok).toBe(true);

    const retired = await sendJson<unknown>(
      `/file-objects/${media.id}`,
      "DELETE",
    );
    expect(retired.status).toBe(204);
    const after = await getJson<{ items: unknown[] }>(
      "/products/field_fence/media",
    );
    expect(after.body.items).toEqual([]);
  });

  it("presign 未配对象存储 ⇒ {configured:false}；sha 非法 ⇒ 422", async () => {
    const ok = await sendJson<{ configured: boolean }>(
      "/file-objects/presign",
      "POST",
      {
        owner_type: "product",
        owner_id: "field_fence",
        kind: "product_photo",
        media_kind: "production",
        name: "x",
        content_type: "image/png",
        size: 100,
        sha256: "a".repeat(64),
      },
    );
    expect(ok.status).toBe(200);
    expect(ok.body.configured).toBe(false);

    const bad = await sendJson<{ detail: { code: string } }>(
      "/file-objects/presign",
      "POST",
      { sha256: "not-a-sha" },
    );
    expect(bad.status).toBe(422);
    expect(bad.body.detail.code).toBe("SHA256_REQUIRED");
  });
});

// ── 租户产品定义 ────────────────────────────────────────────────────────────

describe("tenant-products ← products-definitions-tab.tsx:191-287", () => {
  it("列表是数组；创建/改名/停用/删除都真的改 store", async () => {
    const before =
      await getJson<Array<{ id: number; product_key: string }>>(
        "/tenant-products",
      );
    expect(Array.isArray(before.body)).toBe(true);
    expect(before.body.length).toBe(1);

    const created = await sendJson<{
      id: number;
      product_key: string;
      is_system: boolean;
    }>("/tenant-products", "POST", {
      product_key: "gabion",
      product_name: "石笼网",
      cost_field: "raw_price",
      cost_basis: "pretax",
      profit_mode: "margin_on_price",
      profit_value: 0.1,
      misc_fee_rate: 0.03,
      spec: { key: "gabion" },
    });
    expect(created.status).toBe(201);
    expect(created.body.is_system).toBe(false);

    const dup = await sendJson<{ detail: { code: string } }>(
      "/tenant-products",
      "POST",
      { product_key: "gabion", product_name: "重复" },
    );
    expect(dup.status).toBe(409);
    expect(dup.body.detail.code).toBe("PRODUCT_KEY_TAKEN");

    const renamed = await sendJson<{ product_name: string }>(
      `/tenant-products/${created.body.id}`,
      "PUT",
      { product_name: "石笼网（改）" },
    );
    expect(renamed.body.product_name).toBe("石笼网（改）");

    const status = await sendJson<{ product_key: string; is_enabled: boolean }>(
      "/tenant-product-status",
      "POST",
      { product_key: "gabion", is_enabled: false },
    );
    expect(status.status).toBe(200);
    expect(status.body.is_enabled).toBe(false);
    const statusList = await getJson<{
      items: Array<{ product_key: string; is_enabled: boolean }>;
    }>("/tenant-product-status");
    expect(statusList.body.items).toContainEqual({
      product_key: "gabion",
      is_enabled: false,
    });

    const removed = await sendJson<unknown>(
      `/tenant-products/${created.body.id}`,
      "DELETE",
    );
    expect(removed.status).toBe(204);
    const after = await getJson<unknown[]>("/tenant-products");
    expect(after.body.length).toBe(1);
  });
});

// ── 团队 ────────────────────────────────────────────────────────────────────

describe("团队 member/invite/subscription ← team/components/*（ws_teams.py）", () => {
  it("成员列表 / console-access / 移除管理员 409", async () => {
    const members = await getJson<{
      items: Array<{ user_id: number; is_admin: boolean }>;
    }>("/teams/1/members");
    expect(members.body.items.length).toBe(2);
    expect(members.body.items[0]?.user_id).toBe(1);

    const consoleRes = await sendJson<{ console_access: boolean }>(
      "/teams/1/members/2/console-access",
      "PUT",
      { allowed: true },
    );
    expect(consoleRes.status).toBe(200);
    expect(consoleRes.body.console_access).toBe(true);

    const self = await sendJson<{ detail: { code: string } }>(
      "/teams/1/members/1",
      "DELETE",
    );
    expect(self.status).toBe(409);
    expect(self.body.detail.code).toBe("CANNOT_REMOVE_SELF");
  });

  it("邀请：创建 201 返 token；撤销后 status=revoked", async () => {
    const created = await sendJson<{
      joined: boolean;
      invite_id: number;
      token: string;
    }>("/teams/1/invites", "POST", { email: "new@example.com" });
    expect(created.status).toBe(201);
    expect(created.body.joined).toBe(false);
    expect(created.body.token).toBeTruthy();

    const revoked = await sendJson<{ revoked: boolean }>(
      `/teams/1/invites/${created.body.invite_id}`,
      "DELETE",
    );
    expect(revoked.body.revoked).toBe(true);
    const list = await getJson<{
      items: Array<{ id: number; status: string }>;
    }>("/teams/1/invites");
    expect(
      list.body.items.find((i) => i.id === created.body.invite_id)?.status,
    ).toBe("revoked");
  });

  it("订阅：列表带 created_at；PUT 只回 4 键；DELETE 只置 active=false", async () => {
    const listed = await getJson<{
      items: Array<{
        code: string;
        active: boolean;
        created_at: string | null;
      }>;
    }>("/teams/1/subscriptions");
    expect(listed.body.items[0]?.code).toBe("full_chain");
    expect(listed.body.items[0]?.active).toBe(true);

    const set = await sendJson<Record<string, unknown>>(
      "/teams/1/subscriptions/quotes",
      "PUT",
      { active: true },
    );
    expect(set.status).toBe(200);
    expect(Object.keys(set.body).sort()).toEqual([
      "active",
      "code",
      "expires_at",
      "source",
    ]);

    const revoked = await sendJson<{ revoked: boolean; code: string }>(
      "/teams/1/subscriptions/quotes",
      "DELETE",
    );
    expect(revoked.body).toEqual({ revoked: true, code: "quotes" });
    const after = await getJson<{
      items: Array<{ code: string; active: boolean }>;
    }>("/teams/1/subscriptions");
    expect(after.body.items.find((s) => s.code === "quotes")?.active).toBe(
      false,
    );
  });
});

// ── 企业税档 / 产品税率 ─────────────────────────────────────────────────────

describe("tax-archives / product-tax-rates ← settings/tax-archives/page.tsx", () => {
  it("税档列表/新增/停用；产品税率重复 409、未知产品 422、删除软删", async () => {
    const list = await getJson<{
      items: Array<{ id: number; name: string }>;
      total: number;
    }>("/tax-archives");
    expect(list.body.total).toBe(1);

    const created = await sendJson<{
      id: number;
      tax_values: Record<string, number>;
    }>("/tax-archives", "POST", {
      name: "低税率档",
      code: null,
      effective_from: "2026-10-20",
      tax_values: { output_vat_rate: 0.09, misc_fee_rate: 0.02 },
    });
    expect(created.status).toBe(201);
    expect(created.body.tax_values.output_vat_rate).toBe(0.09);

    const toggled = await sendJson<{ status: string }>(
      `/tax-archives/${created.body.id}`,
      "PATCH",
      { status: "inactive" },
    );
    expect(toggled.body.status).toBe("inactive");
    const afterToggle = await getJson<{ items: unknown[] }>("/tax-archives");
    expect(afterToggle.body.items.length).toBe(1);

    const rates = await getJson<{ items: Array<{ product_key: string }> }>(
      "/product-tax-rates",
    );
    expect(rates.body.items.length).toBe(1);

    const dup = await sendJson<{ detail: { code: string } }>(
      "/product-tax-rates",
      "POST",
      { product_key: "field_fence", input_vat_rate: 0.1 },
    );
    expect(dup.status).toBe(409);
    expect(dup.body.detail.code).toBe("PRODUCT_TAX_EXISTS");

    const unknown = await sendJson<{ detail: { code: string } }>(
      "/product-tax-rates",
      "POST",
      { product_key: "nope", input_vat_rate: 0.1 },
    );
    expect(unknown.status).toBe(422);
    expect(unknown.body.detail.code).toBe("UNKNOWN_PRODUCT");

    const removed = await sendJson<{ status: string }>(
      "/product-tax-rates/1",
      "DELETE",
    );
    expect(removed.body).toEqual({ id: 1, status: "inactive" });
    const afterDelete = await getJson<{ items: unknown[] }>(
      "/product-tax-rates",
    );
    expect(afterDelete.body.items).toEqual([]);
  });
});

// ── 企业信息 / 公章 ─────────────────────────────────────────────────────────

describe("tenant/company-profile ← trade-docs/hooks/use-trade-docs.ts:254/:266", () => {
  it("GET 18 键 + configured；PUT 空 name_en 422；税号归一化；清空字段生效", async () => {
    const profile = await getJson<Record<string, unknown>>(
      "/tenant/company-profile",
    );
    expect(profile.status).toBe(200);
    for (const key of [
      "name_en",
      "name_zh",
      "address_en",
      "address_zh",
      "phone",
      "email",
      "website",
      "tax_id",
      "bank_name",
      "bank_address_en",
      "bank_name_zh",
      "bank_address_zh",
      "bank_account",
      "swift_code",
      "logo_url",
      "default_incoterm",
      "default_payment_terms",
      "default_country_of_origin",
      "configured",
    ]) {
      expect(profile.body, `缺字段 ${key}`).toHaveProperty(key);
    }
    expect(profile.body.configured).toBe(true);
    expect(profile.body.tax_id).toBe("91131125MA0GA4242U");
    expect(profile.body.bank_name_zh).toBe("中国银行安平支行");

    const bad = await sendJson<{ detail: { code: string } }>(
      "/tenant/company-profile",
      "PUT",
      { name_en: "  " },
    );
    expect(bad.status).toBe(422);
    expect(bad.body.detail.code).toBe("NAME_EN_REQUIRED");

    const saved = await sendJson<Record<string, unknown>>(
      "/tenant/company-profile",
      "PUT",
      { name_en: "NEW NAME CO., LTD." },
    );
    expect(saved.status).toBe(200);
    expect(saved.body.name_en).toBe("NEW NAME CO., LTD.");
    // 未提交的字段按后端口径被覆盖为 null（允许"擦掉填错的字段"）
    expect(saved.body.phone).toBeNull();
    expect(saved.body.tax_id).toBeNull();

    // 税号 trim + 大写（用户常粘贴带空格/小写的统一社会信用代码）
    const taxSaved = await sendJson<Record<string, unknown>>(
      "/tenant/company-profile",
      "PUT",
      { name_en: "NEW NAME CO., LTD.", tax_id: " 91131125ma0ga4242u " },
    );
    expect(taxSaved.body.tax_id).toBe("91131125MA0GA4242U");
  });
});

describe("POST /trade-docs ← doc-create-form.tsx（盖公司默认公章随单保存）", () => {
  it("with_seal 显式为 false 时如实保存（不能当没传）", async () => {
    const created = await sendJson<Record<string, unknown>>(
      "/trade-docs",
      "POST",
      { doc_type: "pi", with_seal: false },
    );
    expect(created.status).toBe(201);
    expect(created.body.with_seal).toBe(false);

    const defaulted = await sendJson<Record<string, unknown>>(
      "/trade-docs",
      "POST",
      { doc_type: "pi", with_seal: true },
    );
    expect(defaulted.body.with_seal).toBe(true);
  });
});

describe("tenant/company-seals ← company-seal-card.tsx:68-135", () => {
  it("列表/取图/上传/设默认/删默认 409", async () => {
    const list = await getJson<{
      items: Array<{ id: number; is_default: boolean; preview_url: string }>;
    }>("/tenant/company-seals");
    expect(list.body.items.length).toBe(1);
    expect(list.body.items[0]?.is_default).toBe(true);

    const image = await fetch(`${BASE}/tenant/company-seals/1/image`);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");

    const uploaded = await postForm("/tenant/company-seals", (form) => {
      form.append("file", pngFile("seal.png"));
      form.append("name", "财务章");
      form.append("set_default", "false");
    });
    expect(uploaded.status).toBe(201);
    const seal = (await uploaded.json()) as {
      id: number;
      is_default: boolean;
      width: number;
    };
    expect(seal.is_default).toBe(false);
    expect(seal.width).toBe(1); // 从 PNG IHDR 读出来

    const setDefault = await sendJson<{ is_default: boolean }>(
      `/tenant/company-seals/${seal.id}/default`,
      "PUT",
    );
    expect(setDefault.body.is_default).toBe(true);

    // 刚设为默认的章、且还有别的章 ⇒ 409（要先转移默认，避免单据突然没章可盖）
    const blocked = await sendJson<{ detail: { code: string } }>(
      `/tenant/company-seals/${seal.id}`,
      "DELETE",
    );
    expect(blocked.status).toBe(409);
    expect(blocked.body.detail.code).toBe("DEFAULT_SEAL");

    // 把默认转回原章后即可删除
    await sendJson<{ is_default: boolean }>(
      "/tenant/company-seals/1/default",
      "PUT",
    );
    const removed = await sendJson<{ deleted: boolean }>(
      `/tenant/company-seals/${seal.id}`,
      "DELETE",
    );
    expect(removed.status).toBe(200);
    expect(removed.body.deleted).toBe(true);
  });
});

// ── 如实 404 / 已删除的死路径 ───────────────────────────────────────────────

describe("接口不存在时如实 404，而不是 mock 成 200", () => {
  it("GET /admin/deployment_audit ⇒ 404（后端无此路由，生产 404 属设计）", async () => {
    const res = await fetch(
      `${BASE}/admin/deployment_audit?since=2026-10-13T00:00:00Z&limit=200`,
    );
    expect(res.status).toBe(404);
  });

  it("POST /oss/presign 已从 mock 删除（不再把不存在的接口撑成 200）", async () => {
    await expect(
      fetch(`${BASE}/oss/presign`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: "{}",
      }),
    ).rejects.toThrow();
  });
});
