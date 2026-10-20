import { z } from 'zod';

/**
 * 工位元数据契约（单一来源 / Single Source of Truth）
 * ────────────────────────────────────────────────────
 * 侧边栏、面包屑、页面标题【必须】都从这里读，禁止各自硬编码。
 * 背景：改造前页面名有 3 个来源（侧边栏 navGroups / 面包屑 labelMap / 各页 <h1>），
 *      已经产生真实不一致（/market 面包屑写成「市场调研」，与 /research 重名；4 个工位显示英文 slug）。
 *
 * 同步要求：
 *   · 后端镜像 backend/orchestrator/app/domain/workstations.py 必须与本文件一致
 *   · `pnpm contracts:check`（scripts/contracts-check.ts 的 R2）强制校验
 *
 * 命名纪律：同一事物用一个名字，不同事物用不同名字。
 */

/** 工位生命周期状态 */
export const WorkstationStatus = z.enum([
  'active', // 已上线，正常可用
  'placeholder', // 入口保留，页面为「更新中」占位
  'planned', // 已规划、界面待建（P4），暂不上侧边栏
  'hidden', // 页面保留但【不给侧边栏入口】（如移入头像菜单、已摘除、待定去留）
]);
export type WorkstationStatus = z.infer<typeof WorkstationStatus>;

/** 导航分组（体现业务推进顺序） */
export const NavGroupSchema = z.object({
  key: z.string(),
  /** 组标题；空串表示不显示组标题（用于最顶部的概览位） */
  label: z.string(),
  order: z.number().int(),
  /** 非内部账号是否可见（组级） */
  internalOnly: z.boolean().default(false),
});
export type NavGroup = z.infer<typeof NavGroupSchema>;

export const WorkstationSchema = z.object({
  /** 稳定标识：不随展示名变化（改名不动它） */
  key: z.string(),
  /** 展示名：侧边栏 / 面包屑 / 页面标题的唯一来源 */
  name: z.string(),
  route: z.string(),
  /** 所属分组（对应 NavGroupSchema.key） */
  group: z.string(),
  /** 组内顺序：自上而下体现业务流程 */
  order: z.number().int(),
  /** lucide 图标名（仅字符串，避免契约依赖 React） */
  icon: z.string(),
  /**
   * 仅内部账号可见（**历史语义 = account_type==="internal"**，不含管理员角色要求）。
   *
   * ⚠️ 不要和 `RouteGuard` 的 `adminOnly` 混为一谈：后者 2026-10-20 起收紧为
   * 「internal **且** 管理员角色」（与后端 `_require_platform_ops` 同口径），
   * 用于 /events、/audit-log、/admin/*、/settings 等平台运营页。
   * 本字段决定**侧边栏是否展示**；业务页（/research、/leadgen 等）的 adminOnly=true
   * 只表示"内部员工可见"，顾客不可见。两者同名不同义，改动前先看清调用方。
   */
  adminOnly: z.boolean().default(false),
  status: WorkstationStatus,
  /**
   * 所需订阅编码；null = 免费。
   * 付费墙当前【未启用】（先免费），此处先留好口子，
   * 与 backend .../api/subs.py 的 WORKSTATION_CODES 对齐。
   */
  subscription: z.string().nullable().default(null),
});
export type Workstation = z.infer<typeof WorkstationSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// 分组定义（顺序即业务推进顺序）
// ─────────────────────────────────────────────────────────────────────────────
export const NAV_GROUPS: readonly NavGroup[] = [
  { key: 'overview', label: '', order: 0, internalOnly: false },
  { key: 'leadgen', label: '获客', order: 10, internalOnly: false },
  { key: 'intel', label: '情报', order: 12, internalOnly: true },
  { key: 'data', label: '数据', order: 70, internalOnly: false },
  { key: 'account', label: '账号', order: 80, internalOnly: false },
  { key: 'audit', label: '审计', order: 85, internalOnly: true },
  { key: 'customer', label: '客户', order: 20, internalOnly: false },
  { key: 'business', label: '业务', order: 30, internalOnly: false },
  { key: 'admin', label: '管理', order: 99, internalOnly: true },
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// 子路由展示名
// ─────────────────────────────────────────────────────────────────────────────
/**
 * 工位下的子路由（非独立工位）展示名。
 * 面包屑遇到这些路径段时用中文名，而不是把英文 slug 直接怼给用户。
 */
export const SUB_ROUTE_LABELS: Record<string, string> = {
  'company-profile': '企业信息',
  'tax-archives': '税务管理',
  'ai-providers': 'AI Providers',
  'tenant-products': '产品定义管理',
  'spec-proposals': '属性提案审核',
  wizard: '向导',
  'v2-quote': '产品报价',
};

// ─────────────────────────────────────────────────────────────────────────────
// 工位清单
// ─────────────────────────────────────────────────────────────────────────────
/**
 * 排列规则
 *  1. 主业务链（调研 → 获客 → 报价 → 单证 → 订单 → 出货）自上而下，体现业务推进
 *  2. 支撑类（情报、数据）置于主链之后
 *  3. 客户管理固定在最后、系统设置之前
 *  4. 管理类置于最后
 *  5. 升级订阅移入右上角头像菜单 → 不上侧边栏（status: hidden）
 */
export const WORKSTATIONS: readonly Workstation[] = [
  // ── 概览 ──
  {
    key: 'dashboard',
    name: '仪表盘',
    route: '/dashboard',
    group: 'overview',
    order: 0,
    icon: 'LayoutDashboard',
    adminOnly: false,
    status: 'placeholder', // 现有实现只展示系统运行指标（Token/延迟/采样率），对业务无用 → 改「更新中」
    subscription: null,
  },

  // ── 业务主链 ──
  {
    key: 'research',
    name: '市场调研',
    route: '/research',
    group: 'leadgen',
    order: 10,
    icon: 'PackageSearch',
    adminOnly: true,
    status: 'active',
    subscription: null,
  },
  {
    key: 'leadgen',
    name: '地图源客户信息获取',
    route: '/leadgen',
    group: 'leadgen',
    order: 20,
    icon: 'Target',
    adminOnly: true,
    status: 'active',
    // 付费墙口子（未启用）：设计上需 leadgen_* 订阅
    subscription: 'leadgen_starter',
  },
  {
    key: 'outreach',
    name: '客户触达',
    route: '/outreach',
    group: 'leadgen',
    order: 30,
    icon: 'Send',
    adminOnly: false,
    status: 'active',
    subscription: 'outreach_starter',
  },
  {
    // 报价工位（一个工位一个入口）—— 内部视图：
    //   产品报价（?tab=calc）· 报价记录（?tab=records）· 定价数据（?tab=pricing）
    //   运输报价（P4 接入，依赖后端 customer_freight_rates）
    key: 'quotes',
    name: '报价',
    route: '/quotes',
    group: 'business',
    order: 10,
    icon: 'Zap',
    adminOnly: false,
    // 2026-09-28 已解禁：/api/v1/export-quote/*、/api/v1/quotes、
    // /api/v1/quote-profiles 已随 backend/worker/src/quote_api.py 落到 Worker（线上唯一运行时），
    // 并在测试台 + 生产冒烟中实测通过，因此上侧边栏。
    status: 'active',
    subscription: null,
  },
  {
    // 已并入「报价」工位内部视图（报价记录）；页面保留，不再占侧边栏
    key: 'quote-records',
    name: '报价记录',
    route: '/quotations',
    group: 'business',
    order: 20,
    icon: 'History',
    adminOnly: false,
    status: 'hidden',
    subscription: null,
  },
  {
    key: 'trade-docs',
    name: '单证',
    route: '/trade-docs',
    group: 'business',
    order: 40,
    icon: 'FileText',
    adminOnly: false,
    status: 'active', // 已上线：开单 → 校对 → 签发 → 打印/导出（18 类英文单据）
    subscription: null,
  },
  {
    // 产品素材（图片 + 基础信息）：单证/报价都要**引用**它，
    // 所以属"我的"配置、不按工位收费（subscription: null ⇒ 永不被订阅拦）——
    // 锁掉它等于让付费工位失去素材来源。
    // 2026-10-18 用户要求：侧边栏里「产品」放在「客户管理」上方 ——
    // 产品是报价/单证的素材来源，先配产品再谈客户更符合操作顺序。
    key: 'products',
    name: '产品',
    route: '/products',
    group: 'customer',
    order: 5,
    icon: 'Package',
    adminOnly: false,
    status: 'active',
    subscription: null,
  },
  {
    key: 'orders',
    name: '订单',
    route: '/orders',
    group: 'business',
    order: 30,
    icon: 'ClipboardList',
    adminOnly: false,
    status: 'active', // 已上线：报价转订单 + 贸易条款维护
    subscription: null,
  },
  {
    key: 'shipments',
    name: '出货',
    route: '/shipments',
    group: 'business',
    order: 50,
    icon: 'Truck',
    adminOnly: false,
    // 2026-10-21（C23）恢复上线：`/api/v1/shipments` 4 路由已在 Worker
    // （`backend/worker/src/ws_shipments.py` + `main.py` 已挂载）、前端页面与 6 条测试齐备。
    // 原「2026-09-28 上线门禁」的前提（Worker 没有 shipments 接口）已不成立。
    status: 'active',
    subscription: null,
  },

  // ── 情报（支撑） ──
  {
    // 情报工位：内部板块 = 进出口情报 · 产品市场对照
    key: 'intel',
    name: '市场情报',
    route: '/intel',
    group: 'intel',
    order: 10,
    icon: 'Radar',
    adminOnly: true,
    status: 'active',
    subscription: null,
  },

  // ── 数据（支撑） ──
  {
    // 实为「成本价表」（报价核算的输入数据），已并入「报价」工位内部视图（?tab=pricing）
    // 页面保留，不再占侧边栏 —— 避免与「报价」「报价记录」三个“报价”混淆
    key: 'pricing-data',
    name: '定价数据',
    route: '/pricing-data',
    group: 'data',
    order: 10,
    icon: 'Database',
    adminOnly: false,
    status: 'hidden',
    subscription: null,
  },
  {
    // 已并入「市场情报」工位内部板块；页面保留，不再占侧边栏
    key: 'market',
    name: '产品市场对照',
    route: '/market',
    group: 'data',
    order: 20,
    icon: 'BookOpen',
    adminOnly: true,
    status: 'hidden',
    subscription: null,
  },

  // ── 客户（固定在最后、设置之前） ──
  {
    key: 'customers',
    name: '客户管理',
    route: '/customers',
    group: 'customer',
    order: 10,
    icon: 'Users',
    adminOnly: false,
    status: 'active',
    subscription: null,
  },

  // ── 管理 ──
  {
    key: 'settings',
    name: '系统设置',
    route: '/settings',
    group: 'admin',
    order: 10,
    icon: 'Settings',
    adminOnly: true,
    status: 'active',
    subscription: null,
  },
  {
    key: 'ai-providers',
    name: 'AI Providers',
    route: '/settings/ai-providers',
    group: 'admin',
    order: 20,
    icon: 'Sparkles',
    adminOnly: true,
    status: 'active', // 已并入系统设置内部（侧边栏项保留，位置紧随设置）
    subscription: null,
  },
  {
    // 税务档案（TAX-00 新口径）：团队级档案，团队管理员写、成员只读。
    // 因此 adminOnly=false，成员也能进入查看/用于报价，只是保存按钮按权限禁用。
    key: 'tax-archives',
    name: '税务管理',
    route: '/settings/tax-archives',
    group: 'admin',
    order: 22,
    icon: 'ReceiptText',
    adminOnly: false,
    status: 'active',
    subscription: null,
  },
  {
    // 2026-10-18 用户要求：侧边栏移除「产品定义管理」入口（没用）。
    // 内容早已搬进「产品」工位的「定义」区块（/products?tab=definitions），这里只是重复入口；
    // 页面保留（旧路由 /settings/tenant-products 仅做深链跳转），
    // 因此 status 用 hidden 而不是删条目 —— workstationByRoute 仍能按路由解析到它。
    key: 'tenant-products',
    name: '产品定义管理',
    route: '/settings/tenant-products',
    group: 'admin',
    order: 21,
    icon: 'Package',
    adminOnly: true,
    status: 'hidden',
    subscription: null,
  },

  // ── 不上侧边栏（页面保留 / 待定去留 / 已摘除） ──
  {
    // 团队与工位：入口在右上角头像菜单。**不属于计费工位 → 永远可达**，
    // 是"某工位未开通"时的自救入口（若它自己被锁，用户就没法去开通了）。
    key: 'team',
    name: '团队与工位',
    route: '/team',
    group: 'account',
    order: 5,
    icon: 'Users',
    adminOnly: false,
    status: 'hidden',
    subscription: null,
  },
  {
    key: 'billing',
    name: '升级订阅',
    route: '/billing',
    group: 'account',
    order: 10,
    icon: 'CreditCard',
    adminOnly: false,
    status: 'hidden', // 移入右上角头像菜单
    subscription: null,
  },
  {
    key: 'spec-config',
    name: '规格配置',
    route: '/spec-config',
    group: 'data',
    order: 90,
    icon: 'Layers',
    adminOnly: true,
    status: 'hidden', // 有页面但一直无入口 —— 待用户确认「待上线 / 废弃」
    subscription: null,
  },
  {
    key: 'spec-proposals',
    name: '属性提案审核',
    route: '/admin/spec-proposals',
    group: 'admin',
    order: 90,
    icon: 'ClipboardCheck',
    adminOnly: true,
    status: 'hidden',
    subscription: null,
  },
  {
    key: 'onboarding',
    name: '新手引导',
    route: '/onboarding',
    group: 'account',
    order: 20,
    icon: 'Compass',
    adminOnly: false,
    status: 'hidden', // 已批准摘除
    subscription: null,
  },
  {
    key: 'kb',
    name: '知识库',
    route: '/kb',
    group: 'account',
    order: 30,
    icon: 'BookOpen',
    adminOnly: true,
    status: 'hidden', // 已批准摘除（原为「建设中」占位）
    subscription: null,
  },
  {
    key: 'events',
    name: '事件审计',
    route: '/events',
    group: 'audit',
    order: 10,
    icon: 'ScrollText',
    adminOnly: true,
    status: 'hidden', // 已批准摘除页面；埋点上报保留
    subscription: null,
  },
  {
    key: 'audit-log',
    name: '操作日志',
    route: '/audit-log',
    group: 'audit',
    order: 20,
    icon: 'History',
    adminOnly: true,
    status: 'hidden', // 已批准摘除（实为部署日志，名不副实）
    subscription: null,
  },
  {
    key: 'gray-release',
    name: '灰度切换',
    route: '/admin/gray-release',
    group: 'admin',
    order: 80,
    icon: 'ToggleLeft',
    adminOnly: true,
    status: 'hidden', // 已批准摘除（前端标记后端不消费，空转）
    subscription: null,
  },
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// 派生只读视图（供侧边栏 / 面包屑 / 页面标题共用）
// ─────────────────────────────────────────────────────────────────────────────

/** 侧边栏可见项（排除 planned 与 hidden），已按分组顺序 + 组内顺序排好 */
export function visibleWorkstations(): Workstation[] {
  const groupOrder = new Map(NAV_GROUPS.map((g) => [g.key, g.order]));
  return WORKSTATIONS.filter((w) => w.status === 'active' || w.status === 'placeholder').sort(
    (a, b) => {
      const ga = groupOrder.get(a.group) ?? 999;
      const gb = groupOrder.get(b.group) ?? 999;
      return ga !== gb ? ga - gb : a.order - b.order;
    },
  );
}

/** 路由 → 工位（面包屑与页面标题用；取最长前缀匹配，支持 /settings/ai-providers 这类子路由） */
export function workstationByRoute(pathname: string): Workstation | undefined {
  const candidates = WORKSTATIONS.filter(
    (w) => pathname === w.route || pathname.startsWith(w.route + '/'),
  );
  if (candidates.length === 0) return undefined;
  return candidates.reduce((a, b) => (b.route.length > a.route.length ? b : a));
}

/** 侧边栏分组（只保留有可见项的分组） */
export function visibleNavGroups(): Array<NavGroup & { items: Workstation[] }> {
  const items = visibleWorkstations();
  return NAV_GROUPS.map((g) => ({ ...g, items: items.filter((w) => w.group === g.key) }))
    .filter((g) => g.items.length > 0)
    .sort((a, b) => a.order - b.order);
}
