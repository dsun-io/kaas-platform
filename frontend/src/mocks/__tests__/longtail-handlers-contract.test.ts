// @vitest-environment node
/**
 * C18 长尾域 handler 回归（2026-10-20）
 *
 * 覆盖 `longtail-handlers.ts` 的域名：intel / market / spec-config / admin 属性提案 /
 * ai-providers / auth 长尾 / shipments / research / leadgen / outreach / pricing-data /
 * fx-rates / 报价算价+导入+试算 / 报价单 CRUD。
 *
 * 与 `p1-handlers-contract.test.ts` 同口径：`setupServer` +
 * `onUnhandledRequest:"error"` ⇒ 拿到 200/201 就是"没有放行到网络"的证明。
 * 第二个断言目标是**形状**（每个 describe 标了后端真源）与**写操作真的改 store**。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupServer } from "msw/node";

import { handlers, resetMockData } from "../handlers";

const server = setupServer(...handlers);
const ORIGIN = "http://localhost:3000";
const BASE = `${ORIGIN}/api/v1`;
const JSON_HEADERS = { "Content-Type": "application/json" };

beforeAll(() => {
  // MSW 在 Node 里靠 `location.href` 解析相对 handler 路径（浏览器由 document.baseURI 提供）
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
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

function postForm(path: string, fields: Record<string, string>, file?: File) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  if (file) form.append("file", file, file.name);
  return fetch(`${BASE}${path}`, { method: "POST", body: form });
}

// ── intel ───────────────────────────────────────────────────────────────────

describe("intel ← hooks/use-intel.ts（main.py:867-1040）", () => {
  it("船运分页 / 详情 / 贸易统计 / 采集运行 / 通道分组", async () => {
    const list = await getJson<{ items: Array<{ id: number }>; total: number }>(
      "/intel/shipments?page=1&page_size=20",
    );
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(2);

    const detail = await getJson<{ id: number; bl_no: string }>(
      "/intel/shipments/1",
    );
    expect(detail.body.bl_no).toBe("COSU987654321");

    const missing = await getJson<{ detail: string }>("/intel/shipments/999");
    expect(missing.status).toBe(404);

    const stats = await getJson<Array<{ hs_code: string }>>("/intel/trade-stats");
    expect(Array.isArray(stats.body)).toBe(true);
    expect(stats.body.length).toBe(2);

    const runs = await getJson<Array<{ status: string }>>("/intel/adapter-runs");
    expect(runs.body.length).toBe(2);

    const channels = await getJson<{
      free_channels: Array<{ is_enabled: boolean }>;
      paid_channels: Array<{ message: string }>;
    }>("/intel/channels");
    expect(channels.body.free_channels.length).toBe(2);
    // 后端真源字段是 `is_enabled`（不是 `enabled`）：free 通道恒为已开通，
    // 前端 `isChannelEnabled()` 靠这个字段判断（task-14 A 修复的契约面）。
    expect(channels.body.free_channels[0]?.is_enabled).toBe(true);
    expect(channels.body.paid_channels[0]?.message).toBe("未开通");
  });
});

// ── market ──────────────────────────────────────────────────────────────────

describe("market ← market-view.tsx（main.py:1663-1745）", () => {
  it("地区 / 地区产品 / 品名反查 / 港口 / 用途", async () => {
    const regions = await getJson<string[]>("/market/regions");
    expect(regions.body).toContain("DE-NW");

    const products = await getJson<Array<{ specs: unknown[] }>>(
      "/market/regions/DE-NW/products",
    );
    expect(products.body.length).toBe(2);
    expect(products.body[0]?.specs.length).toBeGreaterThan(0);

    const names = await getJson<Array<{ local_name: string }>>(
      "/market/name-lookup?q=chain",
    );
    expect(names.body.length).toBe(1);
    const noQuery = await getJson<unknown>("/market/name-lookup");
    expect(noQuery.status).toBe(422);

    // 前端拼的是 `/market/ports${params}`（空串或 ?country_code=）—— 两种都要被接住
    const portsAll = await getJson<Array<{ country_code: string }>>(
      "/market/ports",
    );
    expect(portsAll.body.length).toBe(2);
    const portsDe = await getJson<Array<{ country_code: string }>>(
      "/market/ports?country_code=DE",
    );
    expect(portsDe.body.length).toBe(1);
    expect(portsDe.body[0]?.country_code).toBe("DE");

    const usages = await getJson<Array<{ usage_code: string }>>("/market/usages");
    expect(usages.body.length).toBe(2);
  });
});

// ── spec-config + admin 提案 ────────────────────────────────────────────────

describe("spec-config ← use-categories / use-bindings / use-wizard-submit", () => {
  it("品类树 / 详情 / 绑定；向导提交幂等；提案进入管理员列表并可审核", async () => {
    const tree = await getJson<{ items: Array<{ id: number; children: unknown[] }> }>(
      "/spec/categories",
    );
    expect(tree.body.items.length).toBe(2);
    expect(tree.body.items[0]?.children.length).toBe(2);

    const category = await getJson<{ id: number; code: string }>(
      "/spec/categories/2",
    );
    expect(category.body.code).toBe("chain_link");
    const unknownCategory = await getJson<{ error: string }>(
      "/spec/categories/999",
    );
    expect(unknownCategory.body).toEqual({ error: "not_found" });

    const bindings = await getJson<{
      items: Array<{ attribute: { values: unknown[] } }>;
    }>("/spec/categories/2/bindings");
    expect(bindings.body.items.length).toBe(2);
    expect(bindings.body.items[1]?.attribute.values.length).toBe(2);

    const submit = await sendJson<{
      sku_id: number;
      spec_hash: string;
      is_new_sku: boolean;
    }>("/spec/wizard/submit", "POST", {
      category_id: 2,
      spec_values: { wire_diameter: { value: 2.5 } },
    });
    expect(submit.status).toBe(200);
    expect(submit.body.is_new_sku).toBe(true);
    const again = await sendJson<{ sku_id: number; is_new_sku: boolean }>(
      "/spec/wizard/submit",
      "POST",
      { category_id: 2, spec_values: { wire_diameter: { value: 2.5 } } },
    );
    expect(again.body.is_new_sku).toBe(false);
    expect(again.body.sku_id).toBe(submit.body.sku_id);

    const proposal = await sendJson<{ id: number; status: string }>(
      "/spec/wizard/propose-attribute",
      "POST",
      {
        category_id: 2,
        group_code: "surface",
        proposed_name: "锌层克重",
        proposed_type: "number",
      },
    );
    expect(proposal.body.status).toBe("pending");

    const pending = await getJson<{ items: Array<{ proposed_name: string }> }>(
      "/admin/spec/attribute-proposals?status=pending",
    );
    expect(
      pending.body.items.some((p) => p.proposed_name === "锌层克重"),
    ).toBe(true);
    const recommended = await getJson<{ items: Array<{ id: number }> }>(
      "/admin/spec/attribute-proposals/recommended",
    );
    expect(recommended.body.items.length).toBe(1);

    const approve = await sendJson<{
      status: string;
      promoted_attribute_id: number;
    }>(`/admin/spec/attribute-proposals/${recommended.body.items[0]?.id}`, "PATCH", {
      action: "approve",
    });
    expect(approve.body.status).toBe("promoted");
    expect(typeof approve.body.promoted_attribute_id).toBe("number");
  });
});

// ── ai-providers ────────────────────────────────────────────────────────────

describe("ai-providers ← settings/ai-providers/page.tsx（chain.py:532-726）", () => {
  it("任务/Provider/保存密钥/测试/绑定/用量", async () => {
    const tasks = await getJson<{ items: Array<{ task_key: string }> }>(
      "/ai/tasks",
    );
    expect(tasks.body.items.length).toBe(5);

    const providers = await getJson<{
      items: Array<{ provider: string; has_key: boolean }>;
    }>("/ai/providers");
    expect(providers.body.items.length).toBe(3);
    expect(providers.body.items[0]?.has_key).toBe(false);

    // 无 key 时测试 ⇒ 400 NO_API_KEY（后端行为，不是 mock 假装成功）
    const noKeyTest = await sendJson<{ detail: { code: string } }>(
      "/ai/providers/deepseek/test",
      "POST",
    );
    expect(noKeyTest.status).toBe(400);
    expect(noKeyTest.body.detail.code).toBe("NO_API_KEY");

    const saved = await sendJson<{ has_key: boolean; api_key_masked: string }>(
      "/ai/providers/deepseek",
      "PUT",
      { api_key: "sk-mock-123456" },
    );
    expect(saved.body.has_key).toBe(true);
    expect(saved.body.api_key_masked).toBe("sk-****");

    const okTest = await sendJson<{ ok: boolean }>(
      "/ai/providers/deepseek/test",
      "POST",
    );
    expect(okTest.body.ok).toBe(true);

    const badProvider = await sendJson<{ detail: { code: string } }>(
      "/ai/providers/nope",
      "PUT",
      { api_key: "x" },
    );
    expect(badProvider.status).toBe(422);

    const bindings = await getJson<{
      items: Array<{ task_key: string; use_ai: boolean }>;
    }>("/ai/task-bindings");
    expect(bindings.body.items.length).toBe(5);
    const enabled = await sendJson<{ use_ai: boolean; enabled: boolean }>(
      "/ai/task-bindings/email_generation",
      "PUT",
      { enabled: true },
    );
    expect(enabled.body.enabled).toBe(true);
    expect(enabled.body.use_ai).toBe(true);

    const usage = await getJson<{
      items: unknown[];
      stats: Array<{ count: number }>;
    }>("/ai/usage");
    expect(usage.body.stats.length).toBeGreaterThan(0);
  });
});

// ── auth 长尾 ───────────────────────────────────────────────────────────────

describe("auth 长尾 ← forgot/reset/setup-admin 页面", () => {
  it("forgot 不泄露存在性；reset 认 mock 令牌；bootstrap-admin 依次 401/422/403", async () => {
    const bad = await sendJson<{ detail: string }>(
      "/auth/forgot-password",
      "POST",
      { email: "not-an-email" },
    );
    expect(bad.status).toBe(422);

    // forgot 会把令牌打到 console（mock 没有邮件），测试捕获它走完 reset 成功链路
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const forgot = await sendJson<{ ok: boolean }>(
      "/auth/forgot-password",
      "POST",
      { email: "admin@kaas.local" },
    );
    expect(forgot.body.ok).toBe(true);
    const logged = info.mock.calls.map((args) => String(args[0])).join("\n");
    const token = /mock-reset-\d+/.exec(logged)?.[0];
    info.mockRestore();
    expect(token).toBeTruthy();

    const short = await sendJson<{ detail: string }>(
      "/auth/reset-password",
      "POST",
      { token: token ?? "", new_password: "123" },
    );
    expect(short.status).toBe(422);

    const wrong = await sendJson<{ detail: { error: string } }>(
      "/auth/reset-password",
      "POST",
      { token: "nope", new_password: "longenough" },
    );
    expect(wrong.status).toBe(400);
    expect(wrong.body.detail.error).toBe("invalid_token");

    const ok = await sendJson<{ ok: boolean }>("/auth/reset-password", "POST", {
      token,
      new_password: "longenough",
    });
    expect(ok.body.ok).toBe(true);

    // bootstrap-admin：无 Bearer 401；密码短 422；已初始化 403
    const noAuth = await fetch(`${BASE}/auth/bootstrap-admin`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: "x@y.z", password: "12345678" }),
    });
    expect(noAuth.status).toBe(401);
    const noAuthBody = await noAuth.text();
    expect(noAuthBody).toContain("Not authenticated");

    const shortPwd = await fetch(`${BASE}/auth/bootstrap-admin`, {
      method: "POST",
      headers: { ...JSON_HEADERS, Authorization: "Bearer setup-token" },
      body: JSON.stringify({ email: "x@y.z", password: "123" }),
    });
    expect(shortPwd.status).toBe(422);

    const initialized = await fetch(`${BASE}/auth/bootstrap-admin`, {
      method: "POST",
      headers: { ...JSON_HEADERS, Authorization: "Bearer setup-token" },
      body: JSON.stringify({ email: "x@y.z", password: "longenough" }),
    });
    expect(initialized.status).toBe(403);
  });
});

// ── shipments ───────────────────────────────────────────────────────────────

describe("shipments ← shipments/page.tsx（ws_shipments.py:134-156）", () => {
  it("列表 / 建单 / 改状态", async () => {
    const list = await getJson<{ items: Array<{ shipment_no: string }> }>(
      "/shipments",
    );
    expect(list.body.items.length).toBe(2);

    const created = await sendJson<{ id: number; shipment_no: string; status: string }>(
      "/shipments",
      "POST",
      { order_id: 1 },
    );
    expect(created.status).toBe(201);
    expect(created.body.shipment_no).toMatch(/^SH-/);
    expect(created.body.status).toBe("planned");

    const patched = await sendJson<{ status: string }>(
      `/shipments/${created.body.id}`,
      "PATCH",
      { status: "booked", vessel: "MSC ANNA" },
    );
    expect(patched.body.status).toBe("booked");
  });
});

// ── research ────────────────────────────────────────────────────────────────

describe("research ← research/page.tsx（chain.py:1830-2130）", () => {
  it("统计/品类/筛选/从线索挑选/编辑/删除/运行历史", async () => {
    const stats = await getJson<{ total: number; can_supply_yes: number }>(
      "/research/stats",
    );
    expect(stats.body.total).toBe(2);
    expect(stats.body.can_supply_yes).toBe(1);

    const categories = await getJson<{ items: string[] }>("/research/categories");
    expect(categories.body.items.length).toBe(10);

    const filtered = await getJson<{ items: Array<{ country: string }> }>(
      "/research/products?country=DE",
    );
    expect(filtered.body.items.length).toBe(1);

    const picked = await sendJson<{
      scanned: number;
      created: number;
      items: Array<{ id: number }>;
    }>("/research/from-leadgen", "POST", { lead_ids: [1] });
    expect(picked.status).toBe(201);
    expect(picked.body.created).toBe(1);
    const again = await sendJson<{ created: number; skipped: number }>(
      "/research/from-leadgen",
      "POST",
      { lead_ids: [1] },
    );
    expect(again.body.created).toBe(0);
    expect(again.body.skipped).toBe(1);

    const researchId = picked.body.items[0]?.id;
    const patched = await sendJson<{ can_supply: boolean }>(
      `/research/products/${researchId}`,
      "PATCH",
      { can_supply: true, market_note: "高需求" },
    );
    expect(patched.body.can_supply).toBe(true);

    const removed = await sendJson<{ deleted: number }>(
      `/research/products/${researchId}`,
      "DELETE",
    );
    expect(removed.body.deleted).toBe(researchId);
    const after = await getJson<{ total: number }>("/research/products");
    expect(after.body.total).toBe(2);

    const runs = await getJson<{ items: unknown[] }>("/research/runs");
    expect(runs.body.items.length).toBeGreaterThanOrEqual(2);
  });
});

// ── leadgen ─────────────────────────────────────────────────────────────────

describe("leadgen ← leadgen/page.tsx（chain.py:940-1250/1751-1808）", () => {
  it("地区/校验/运行/线索列表与详情/编辑/爬取/扫描回复", async () => {
    const regions = await getJson<{ items: string[] }>("/leadgen/regions");
    expect(regions.body.items.length).toBeGreaterThan(0);

    const valid = await sendJson<{ result: { valid: boolean; issues: string[] } }>(
      "/leadgen/validate",
      "POST",
      { region: "", industry: "", quantity: 0 },
    );
    expect(valid.body.result.valid).toBe(false);
    expect(valid.body.result.issues.length).toBe(3);

    const runsBefore = await getJson<{ items: unknown[] }>("/leadgen/runs");
    expect(runsBefore.body.items.length).toBe(1);

    const created = await sendJson<{
      id: number;
      leads_kept: number;
      deduplicated: boolean;
    }>("/leadgen/runs", "POST", {
      region: "DE-NW",
      industry: "fence",
      quantity: 5,
      source: "demo",
    });
    expect(created.status).toBe(201);
    expect(created.body.leads_kept).toBe(2);
    const dedup = await sendJson<{ deduplicated: boolean }>(
      "/leadgen/runs",
      "POST",
      { region: "DE-NW", industry: "fence", quantity: 5, source: "demo" },
    );
    expect(dedup.body.deduplicated).toBe(true);

    const leads = await getJson<{
      items: Array<{ id: number; fit_score: number }>;
      total: number;
    }>("/leads?sort=score&page_size=100");
    expect(leads.body.total).toBeGreaterThanOrEqual(4);
    expect(leads.body.items[0]?.fit_score).toBeGreaterThanOrEqual(
      leads.body.items[1]?.fit_score ?? 0,
    );

    const detail = await getJson<{
      id: number;
      outreach_history: Array<{ status: string }>;
      inquiry_history: unknown[];
    }>("/leads/1");
    expect(detail.body.outreach_history.length).toBe(1);
    expect(detail.body.outreach_history[0]?.status).toBe("sent");

    const patched = await sendJson<{ can_supply: boolean | null }>(
      "/leads/2",
      "PATCH",
      { can_supply: true },
    );
    expect(patched.body.can_supply).toBe(true);

    const crawled = await sendJson<{ result: { status: string } }>(
      "/leads/1/crawl",
      "POST",
    );
    expect(crawled.body.result.status).toBe("success");
    const noWebsite = await sendJson<{ result: { status: string } }>(
      "/leads/3/crawl",
      "POST",
    );
    expect(noWebsite.body.result.status).toBe("no_website");

    const batch = await sendJson<{
      crawled: number;
      success: number;
      no_website: number;
    }>("/leads/crawl-batch", "POST", { only_pending: true, limit: 10 });
    expect(batch.body.crawled).toBeGreaterThan(0);

    const scan = await sendJson<{ scanned: number; created: number }>(
      "/leads/scan-replied",
      "POST",
    );
    expect(scan.body.scanned).toBe(1);
    const scanAgain = await sendJson<{ scanned: number }>(
      "/leads/scan-replied",
      "POST",
    );
    expect(scanAgain.body.scanned).toBe(0);
  });
});

// ── outreach ────────────────────────────────────────────────────────────────

describe("outreach ← outreach/page.tsx（chain.py:1374-1660）", () => {
  it("邮箱/活动/生成/发送/消息/重试", async () => {
    const mailboxes = await getJson<{ items: Array<{ id: number }>; total: number }>(
      "/outreach/mailboxes",
    );
    expect(mailboxes.body.total).toBe(2);

    const duplicate = await sendJson<{ error: string; code: string }>(
      "/outreach/mailboxes",
      "POST",
      { email: "export@kaas.example" },
    );
    expect(duplicate.status).toBe(409);

    const added = await sendJson<{ id: number; is_default: boolean }>(
      "/outreach/mailboxes",
      "POST",
      { email: "new@kaas.example", name: "新邮箱", is_default: true },
    );
    expect(added.status).toBe(201);
    expect(added.body.is_default).toBe(true);

    const madeDefault = await sendJson<{ is_default: boolean }>(
      "/outreach/mailboxes/1",
      "PATCH",
      { is_default: true },
    );
    expect(madeDefault.body.is_default).toBe(true);

    const testDisabled = await sendJson<{ status: string }>(
      "/outreach/mailboxes/2/test",
      "POST",
    );
    expect(testDisabled.body.status).toBe("failed");
    const testOk = await sendJson<{ status: string }>(
      "/outreach/mailboxes/1/test",
      "POST",
    );
    expect(testOk.body.status).toBe("sent");

    const campaigns = await getJson<{ items: Array<{ id: number }> }>(
      "/outreach/campaigns",
    );
    expect(campaigns.body.items.length).toBe(1);

    const campaign = await sendJson<{ id: number; status: string }>(
      "/outreach/campaigns",
      "POST",
      {
        name: "美国市场开发",
        subject_template: "Factory-direct {{product}}",
        body_template: "Dear {{contact_name}}",
      },
    );
    expect(campaign.status).toBe(201);

    const generated = await sendJson<{
      result: { subject?: string; body?: string };
      path: string;
    }>("/outreach/generate", "POST", { payload: { purpose: "cold_outreach" } });
    expect(generated.body.result.subject).toBeTruthy();
    expect(generated.body.path).toBe("template");

    const sent = await sendJson<{ total: number; sent: number; failed: number }>(
      `/outreach/campaigns/${campaign.body.id}/send`,
      "POST",
      { lead_ids: [1, 2] },
    );
    expect(sent.body).toMatchObject({ total: 2, sent: 2, failed: 0 });

    const messages = await getJson<{ items: Array<{ status: string }> }>(
      "/outreach/messages?status=sent",
    );
    expect(messages.body.items.length).toBeGreaterThanOrEqual(3);

    const retried = await sendJson<{ status: string }>(
      "/outreach/messages/2/retry",
      "POST",
    );
    expect(retried.body.status).toBe("sent");
    const notRetryable = await sendJson<{ error: string; code: string }>(
      "/outreach/messages/1/retry",
      "POST",
    );
    expect(notRetryable.status).toBe(409);
    expect(notRetryable.body.code).toBe("NOT_RETRYABLE");

    const opened = await getJson<{ to_email: string }>("/outreach/messages/1");
    expect(opened.body.to_email).toBe("sales@hansa-fence.example");
  });
});

// ── pricing-data ────────────────────────────────────────────────────────────

describe("pricing-data ← pricing-data/hooks（main.py:2183-2400）", () => {
  it("保存单元后矩阵里出现配置值；删除后回退兜底值", async () => {
    const before = await getJson<{ rows: Array<{ configured: boolean }> }>(
      "/pricing-data?product_key=field_fence",
    );
    expect(before.body.rows.length).toBe(3);

    const saved = await sendJson<{
      id: number;
      product_key: string;
      key: string;
      status: string;
    }>("/pricing-data", "POST", {
      product_key: "field_fence",
      values: { wire_diameter: 3.5 },
      amount: 2.9,
      unit: "元/平方米",
      effective_from: "2026-10-20",
    });
    expect(saved.status).toBe(201);
    expect(saved.body.key).toBe("wire_diameter=3.5");

    const after = await getJson<{
      rows: Array<{ key: string; configured: boolean; amount: number }>;
    }>("/pricing-data?product_key=field_fence");
    const row = after.body.rows.find((r) => r.key === "wire_diameter=3.5");
    expect(row).toMatchObject({ configured: true, amount: 2.9 });

    const removed = await sendJson<{ id: number; status: string }>(
      `/pricing-data/${saved.body.id}`,
      "DELETE",
    );
    expect(removed.body.status).toBe("inactive");
    const fallback = await getJson<{
      rows: Array<{ key: string; configured: boolean }>;
    }>("/pricing-data?product_key=field_fence");
    expect(
      fallback.body.rows.find((r) => r.key === "wire_diameter=3.5")?.configured,
    ).toBe(false);
  });
});

// ── fx ──────────────────────────────────────────────────────────────────────

describe("GET /fx-rates/latest ← use-latest-fx.ts", () => {
  it("返回 6 键可解析汇率", async () => {
    const rate = await getJson<{
      base_currency: string;
      quote_currency: string;
      rate: number;
      rate_date: string;
      is_stale: boolean;
    }>("/fx-rates/latest?base_currency=USD&quote_currency=CNY");
    expect(rate.body.base_currency).toBe("USD");
    expect(rate.body.rate).toBe(7.18);
    expect(typeof rate.body.rate_date).toBe("string");
  });
});

// ── 报价单 CRUD ─────────────────────────────────────────────────────────────

describe("报价单 CRUD ← use-quote-orders.ts（contracts/quote-order.ts）", () => {
  it("列表/新建/改单头/换行项/批量/成本参考", async () => {
    const list = await getJson<{
      items: Array<{ quote_no_editable: boolean; item_count: number }>;
      total: number;
    }>("/quotes");
    expect(list.body.total).toBe(1);
    expect(list.body.items[0]?.item_count).toBe(1);
    // 种子报价已有下游单证（doc#4 quote_id=1）⇒ 单号锁定
    expect(list.body.items[0]?.quote_no_editable).toBe(false);

    const created = await sendJson<{
      id: number;
      quote_no: string;
      total_amount: number;
      items: Array<{ line_amount: number }>;
      quote_no_editable: boolean;
    }>("/quotes", "POST", {
      customer_id: "1",
      inquiry_id: 1,
      currency: "USD",
      items: [
        {
          product_name: "Field Fence",
          qty: 10,
          qty_unit: "ROLLS",
          unit_price: 300,
        },
      ],
    });
    expect(created.status).toBe(201);
    expect(created.body.total_amount).toBe(3000);
    expect(created.body.quote_no_editable).toBe(true);

    const patched = await sendJson<{ status: string }>(
      `/quotes/${created.body.id}`,
      "PATCH",
      { status: "sent" },
    );
    expect(patched.body.status).toBe("sent");

    const replaced = await sendJson<{
      total_amount: number;
      items: Array<{ qty: number }>;
    }>(`/quotes/${created.body.id}/items`, "PUT", {
      items: [
        { product_name: "Chain Link", qty: 2, unit_price: 100 },
        { product_name: "Gabion", qty: 3, unit_price: 50 },
      ],
    });
    expect(replaced.body.items.length).toBe(2);
    expect(replaced.body.total_amount).toBe(350);

    const batch = await sendJson<{
      created: unknown[];
      failed: Array<{ code: string }>;
      total: number;
    }>("/quotes/batch", "POST", {
      groups: [
        { customer_id: "1", inquiry_id: 1, items: [] },
        { customer_id: "1", inquiry_id: 999, items: [] },
      ],
    });
    expect(batch.status).toBe(201);
    expect(batch.body.created.length).toBe(1);
    expect(batch.body.failed[0]?.code).toBe("QUOTE_EXISTS");
    expect(batch.body.total).toBe(2);

    // 先写一个定价单元，再查成本参考（mock 用定价单元当成本历史来源）
    await sendJson("/pricing-data", "POST", {
      product_key: "field_fence",
      values: { wire_diameter: 2.5 },
      amount: 2.5,
      unit: "元/平方米",
    });
    const reference = await getJson<{
      reference: { cost: number; source: string } | null;
    }>(
      `/quotes/cost-reference?product_key=field_fence&spec=${encodeURIComponent(
        JSON.stringify({ wire_diameter: 2.5 }),
      )}`,
    );
    expect(reference.body.reference?.cost).toBe(2.5);
    expect(reference.body.reference?.source).toBe("latest");
  });
});

// ── 算价 / 导入 / 试算 ──────────────────────────────────────────────────────

describe("export-quote calculate / import / explain（contracts/export-quote.ts）", () => {
  it("calculate 返回 meta + customer/customer_en 表（含行项落库读的列）", async () => {
    const calc = await sendJson<{
      meta: { product_key: string; quote_currency: string };
      view: string;
      customer: { header: string[]; rows: Array<Array<unknown>> };
      customer_en: { rows: Array<Array<unknown>> };
    }>("/export-quote/calculate", "POST", {
      product_key: "field_fence",
      fx_rate: 7.18,
      fx_source: "manual",
      orders: [{ total: 12, unit: "ROLLS" }],
      spec_rows: [{ d: 2.5 }],
      quote_date: "2026-10-20",
      validity_days: 30,
      currency: "CNY",
      quote_currency: "USD",
    });
    expect(calc.status).toBe(200);
    expect(calc.body.meta.product_key).toBe("field_fence");
    expect(calc.body.customer.header.length).toBeGreaterThan(0);
    expect(calc.body.customer.rows[0]?.length).toBe(
      calc.body.customer.header.length,
    );
    // `buildLineItem` 读的单卷外币价（COL.unitPriceFx）必须是非空数值
    expect(calc.body.customer.rows[0]).toContain(301.03);
  });

  it("import-template / preview / calculate / explain 形状可驱动页面", async () => {
    const info = await getJson<{
      product_key: string;
      columns: Array<{ header: string; target: string }>;
      headers: string[];
      download: Record<string, string>;
    }>("/export-quote/products/field_fence/import-template");
    expect(info.body.columns.length).toBeGreaterThan(0);
    expect(info.body.download.csv).toContain("import-template");

    const preview = await postForm(
      "/export-quote/import/preview",
      { product_key: "field_fence" },
      new File([new Uint8Array([1, 2, 3])], "sample.xlsx"),
    );
    expect(preview.status).toBe(200);
    const previewBody = (await preview.json()) as {
      usable_rows: number;
      rows: Array<Record<string, unknown>>;
      issues: Array<{ severity: string }>;
    };
    expect(previewBody.usable_rows).toBe(1);
    expect(previewBody.issues[0]?.severity).toBe("warning");

    const calc = await postForm(
      "/export-quote/import/calculate",
      { product_key: "field_fence", view: "customer" },
      new File([new Uint8Array([1, 2, 3])], "sample.xlsx"),
    );
    expect(calc.status).toBe(200);
    const calcBody = (await calc.json()) as {
      meta: { product_key: string };
      import: { usable_rows: number };
      spec_rows: { computed: number };
    };
    expect(calcBody.meta.product_key).toBe("field_fence");
    expect(calcBody.import.usable_rows).toBe(1);
    expect(calcBody.spec_rows.computed).toBe(1);

    const explain = await sendJson<{
      steps: Array<{ key: string; expr: string }>;
      ok: boolean;
    }>("/export-quote/products/field_fence/explain", "POST", {
      spec: { d: 2.5 },
    });
    expect(explain.body.steps.length).toBeGreaterThan(0);
    expect(explain.body.steps[0]).toHaveProperty("expr");
  });
});
