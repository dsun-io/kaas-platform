import { http, HttpResponse, delay } from 'msw';
import {
  makeEvent, makeDashboardSummary, makeTenant, makeFeatureFlags,
  MOCK_CUSTOMERS, MOCK_CAPABILITIES, MOCK_QUOTATIONS, MOCK_DEPLOYMENT_AUDITS,
  makeCapability, makeSyncJob, makeQuotation,
} from './data/factory';

const EVENTS_LIST = Array.from({ length: 12 }, (_, i) =>
  makeEvent({
    event_type: (
      ['chat.turn', 'quote.request', 'quote.response', 'audit.access', 'capability.update', 'kb.edit'] as const
    )[i % 6],
    created_at: new Date(Date.now() - i * 3600000).toISOString(),
    sampled: i % 5 === 0,
  }),
);

// Stateful store for capabilities (supports PATCH mutations)
const capabilitiesStore = new Map<string, ReturnType<typeof makeCapability>[]>();
capabilitiesStore.set('cust-liankai', JSON.parse(JSON.stringify(MOCK_CAPABILITIES['cust-liankai'])));
capabilitiesStore.set('cust-client-b', JSON.parse(JSON.stringify(MOCK_CAPABILITIES['cust-client-b'])));

// Stateful store for feature flags
let featureFlagsStore = { use_v2: false, sampling_enabled: true };

export const handlers = [
  // ── Events ───────────────────────────────────────────────────────
  http.get('/api/v1/events', ({ request }) => {
    const url = new URL(request.url);
    const errorCode = url.searchParams.get('error');
    if (errorCode === '500') {
      return HttpResponse.json(
        { error_code: 'INTERNAL_ERROR', message: '服务器内部错误，请稍后重试', detail: { source: 'mock' } },
        { status: 500 },
      );
    }
    if (errorCode === '429') {
      return HttpResponse.json(
        { error_code: 'RATE_LIMITED', message: '请求过于频繁，请稍后重试' },
        { status: 429 },
      );
    }
    const eventType = url.searchParams.get('event_type');
    const tenantId = url.searchParams.get('tenant_id');
    let filtered = EVENTS_LIST;
    if (eventType) filtered = filtered.filter((e) => e.event_type === eventType);
    if (tenantId) filtered = filtered.filter((e) => e.tenant_id === tenantId);
    return HttpResponse.json({ items: filtered, total: filtered.length, page: 1, page_size: 20 });
  }),

  http.post('/api/v1/events', async ({ request }) => {
    const body = await request.json() as Record<string, unknown>;
    const created = makeEvent({ ...body, event_source: 'frontend' } as Record<string, unknown>);
    return HttpResponse.json({ id: created.id }, { status: 201 });
  }),

  // ── Dashboard ────────────────────────────────────────────────────
  http.get('/api/v1/dashboard/summary', ({ request }) => {
    const url = new URL(request.url);
    const range = url.searchParams.get('range') ?? 'today';
    const ranges: Record<string, ReturnType<typeof makeDashboardSummary>> = {
      today: makeDashboardSummary({ range: 'today', quotations_total: 42 }),
      '7d': makeDashboardSummary({ range: '7d', quotations_total: 310, quotations_sampled: 75 }),
      '30d': makeDashboardSummary({ range: '30d', quotations_total: 1240, quotations_sampled: 300 }),
    };
    return HttpResponse.json(ranges[range] ?? ranges.today);
  }),

  // ── OSS ──────────────────────────────────────────────────────────
  http.post('/api/v1/oss/presign', () => {
    return HttpResponse.json({
      presigned_url: 'https://oss.example.com/upload/mock',
      key: `events/mock-${Date.now()}.json`,
    });
  }),

  // ── Customers ────────────────────────────────────────────────────
  http.get('/api/v1/customers', () => {
    return HttpResponse.json(MOCK_CUSTOMERS);
  }),

  http.get('/api/v1/customers/:id', ({ params }) => {
    const customer = MOCK_CUSTOMERS.find((c) => c.customer_id === params.id);
    if (!customer) {
      return HttpResponse.json(
        { error_code: 'TENANT_NOT_FOUND', message: '租户配置未找到，请检查设置', detail: { customer_id: params.id } },
        { status: 404 },
      );
    }
    return HttpResponse.json(customer);
  }),

  http.get('/api/v1/customer/:id/capabilities', ({ params }) => {
    const customerId = params.id as string;
    if (customerId === 'unknown') {
      return HttpResponse.json(
        { error_code: 'TENANT_NOT_FOUND', message: '租户配置未找到，请检查设置', detail: { tenant_id: 'unknown' } },
        { status: 404 },
      );
    }
    const caps = capabilitiesStore.get(customerId) ?? [];
    return HttpResponse.json(caps);
  }),

  http.patch('/api/v1/customer/:id/capabilities', async ({ params, request }) => {
    const body = await request.json() as { id: string; spec_constraints?: Record<string, unknown>; is_active?: boolean };
    const customerCaps = capabilitiesStore.get(params.id as string) ?? [];
    const idx = customerCaps.findIndex((c) => c.id === body.id);
    if (idx === -1) {
      return HttpResponse.json(
        { error_code: 'QUOTATION_NOT_FOUND', message: '报价记录不存在', detail: { capability_id: body.id } },
        { status: 404 },
      );
    }

    if (body.spec_constraints) customerCaps[idx]!.spec_constraints = body.spec_constraints;
    if (body.is_active !== undefined) customerCaps[idx]!.is_active = body.is_active;
    customerCaps[idx]!.updated_at = new Date().toISOString();

    const syncJob = makeSyncJob({ id: `sync-${Date.now()}`, status: 'pending' });
    return HttpResponse.json({ capability: customerCaps[idx], sync_job_id: syncJob.id });
  }),

  // ── Sync Jobs ────────────────────────────────────────────────────
  http.get('/api/v1/sync_jobs/:id', async ({ params }) => {
    await delay(500);
    return HttpResponse.json({
      id: params.id,
      status: 'done',
      created_at: new Date(Date.now() - 3000).toISOString(),
      completed_at: new Date().toISOString(),
    });
  }),

  // ── Quotations ───────────────────────────────────────────────────
  http.get('/api/v1/quotations', ({ request }) => {
    const url = new URL(request.url);
    const customerId = url.searchParams.get('customer_id');
    const productCategory = url.searchParams.get('product_category');
    let filtered = MOCK_QUOTATIONS;
    if (customerId) filtered = filtered.filter((q) => q.customer_id === customerId);
    if (productCategory) filtered = filtered.filter((q) => q.product_category === productCategory);
    filtered.sort((a, b) => new Date(b.effective_from).getTime() - new Date(a.effective_from).getTime());
    return HttpResponse.json({ items: filtered, total: filtered.length });
  }),

  http.post('/api/v1/quotation', async ({ request }) => {
    const body = await request.json() as Record<string, unknown>;
    const created = makeQuotation({
      ...body,
      id: `q-new-${Date.now()}`,
      quotation_id: `Q-2025-${String(Math.floor(Math.random() * 9999)).padStart(4, '0')}`,
      source: 'manual',
      spec_hash: `hash-${Math.random().toString(36).slice(2, 10)}`,
      created_at: new Date().toISOString(),
      effective_from: new Date().toISOString(),
    } as Record<string, unknown>);
    MOCK_QUOTATIONS.unshift(created);
    return HttpResponse.json({ id: created.id, spec_hash: created.spec_hash }, { status: 201 });
  }),

  // ── Quote main API ───────────────────────────────────────────────
  http.post('/api/v1/quote', async ({ request }) => {
    const body = await request.json() as { product_category?: string; spec?: Record<string, unknown> };
    if (!body.product_category || !body.spec) {
      return HttpResponse.json(
        { error_code: 'VALIDATION_ERROR', message: 'product_category 和 spec 为必填字段', detail: { missing: !body.product_category ? ['product_category'] : ['spec'] } },
        { status: 422 },
      );
    }
    const cat = body.product_category;
    if (cat === '立柱') {
      return HttpResponse.json({
        session_id: 'sess-mock',
        customer_id: 'cust-liankai',
        items: [{ product_category: '立柱', product_spec: {}, quantity: 100, unit_price: 45.0, confidence: 'high' }],
        status: 'matched',
        source: 'quotations_db',
      });
    }
    return HttpResponse.json({
      session_id: 'sess-mock',
      customer_id: 'cust-liankai',
      items: [{ product_category: '牛栏网', product_spec: { 丝径: '2.5mm', 网孔: '75x75' }, quantity: 1000, unit_price: 3.85, confidence: 'high' }],
      status: 'matched',
      source: 'quotations_db',
    });
  }),

  // ── Feature Flags ────────────────────────────────────────────────
  http.get('/api/v1/admin/feature_flag', () => {
    return HttpResponse.json({ ...featureFlagsStore });
  }),

  http.post('/api/v1/admin/feature_flag', async ({ request }) => {
    const body = await request.json() as { flag_key: string; enabled: boolean; reason: string; actor_id: string };
    const before = featureFlagsStore[body.flag_key as keyof typeof featureFlagsStore] ?? false;
    (featureFlagsStore as Record<string, boolean>)[body.flag_key] = body.enabled;
    const after = body.enabled;
    return HttpResponse.json({ flag_key: body.flag_key, before, after });
  }),

  // ── Deployment Audit ─────────────────────────────────────────────
  http.get('/api/v1/admin/deployment_audit', ({ request }) => {
    const url = new URL(request.url);
    const since = url.searchParams.get('since');
    let filtered = MOCK_DEPLOYMENT_AUDITS;
    if (since) {
      const sinceDate = new Date(since).getTime();
      filtered = filtered.filter((a) => new Date(a.timestamp).getTime() >= sinceDate);
    }
    return HttpResponse.json({ items: filtered.slice(0, 200), total: filtered.length });
  }),

  // ── Audit Log ────────────────────────────────────────────────────
  http.get('/api/v1/admin/audit-log', ({ request }) => {
    const url = new URL(request.url);
    const action = url.searchParams.get('action');
    const actorId = url.searchParams.get('actor_id');
    const resourceType = url.searchParams.get('resource_type');
    const since = url.searchParams.get('since');
    const until = url.searchParams.get('until');

    let items = [
      ...MOCK_DEPLOYMENT_AUDITS,
      { id: 'op-1', action: 'tenant.reload', actor_id: 'admin-1', resource_type: 'tenant', resource_id: 'liankai', reason: '手动刷新租户配置', timestamp: new Date(Date.now() - 3600000).toISOString() },
      { id: 'op-2', action: 'capability.update', actor_id: 'admin-1', resource_type: 'capability', resource_id: 'cap-001', reason: '更新牛栏网丝径约束范围', timestamp: new Date(Date.now() - 7200000).toISOString() },
      { id: 'op-3', action: 'quotation.create', actor_id: 'admin-1', resource_type: 'quotation', resource_id: 'q-new-001', reason: '手动录入报价 Q-2025-0011', timestamp: new Date(Date.now() - 14400000).toISOString() },
      { id: 'op-4', action: 'oss.upload', actor_id: 'system', resource_type: 'oss', resource_id: 'events/2025-04-01.json', reason: '事件归档上传至 OSS', timestamp: new Date(Date.now() - 86400000).toISOString() },
      { id: 'op-5', action: 'tenant.reload', actor_id: 'admin-1', resource_type: 'tenant', resource_id: 'client-b', reason: '新增客户 B 租户配置', timestamp: new Date(Date.now() - 2 * 86400000).toISOString() },
    ];

    if (action) items = items.filter((e) => e.action === action);
    if (actorId) items = items.filter((e) => e.actor_id === actorId);
    if (resourceType) items = items.filter((e) => e.resource_type === resourceType);
    if (since) {
      const sinceDate = new Date(since).getTime();
      items = items.filter((e) => new Date(e.timestamp).getTime() >= sinceDate);
    }
    if (until) {
      const untilDate = new Date(until).getTime();
      items = items.filter((e) => new Date(e.timestamp).getTime() <= untilDate);
    }

    items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return HttpResponse.json({ items, total: items.length });
  }),

  // ── Tenants / Reload ─────────────────────────────────────────────
  http.get('/api/v1/admin/tenants', () => {
    return HttpResponse.json([
      makeTenant({ tenant_id: 'liankai', name: '联凯五金', is_active: true }),
      makeTenant({ tenant_id: 'client-b', name: '备选客户 B', is_active: true }),
    ]);
  }),

  http.post('/api/v1/admin/tenants/reload', () => {
    return HttpResponse.json({
      reloaded_count: 2,
      active_tenants: [
        { tenant_id: 'liankai', display_name: '联凯五金', locale: 'zh-CN', region: 'cn-north' },
        { tenant_id: 'client-b', display_name: '备选客户 B', locale: 'zh-CN', region: 'cn-south' },
      ],
    });
  }),
];
