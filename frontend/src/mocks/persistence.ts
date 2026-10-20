/**
 * Mock 数据持久层（C5：mock 模式刷新不丢数据）
 *
 * ## 为什么需要
 * `handlers.ts` 等模块的 store 是**模块内存态**：mock 模式下每次刷新都会重新 import
 * 模块 ⇒ 新建的客户/报价/单证在刷新后全部消失。手测时"刚建的数据一刷新就没了"
 * 会让人怀疑是后端/写入坏了，实际只是 mock 的内存态被重建。
 *
 * ## 设计（守住四条）
 * 1. **版本化键**：`kaas-mock-v1:<集合名>`。`MOCK_STORAGE_VERSION` 变了 ⇒ 旧键一律丢弃重建
 *    （schema 不兼容时不会把坏数据灌进新代码）。
 * 2. **只持久化被写操作碰过的集合**：`mark`/`persist` 由请求映射驱动
 *    （见 `WRITE_RULES`：`POST/PUT/PATCH/DELETE` + URL → 受影响的集合），
 *    **不做"全量快照"**。只读大对象（事件列表、产品注册表种子等）永远不落盘（5MB 配额）。
 * 3. **SSR / Node 安全**：`typeof window === "undefined"` 或 localStorage 不可用
 *    （隐私模式/配额满/测试环境）时所有函数**静默 no-op**，业务照常用内存态。
 * 4. **e2e/CI 确定性**：默认走种子（没有持久化键时 hydrate 什么也不做）；
 *    `localStorage["kaas-mock-fresh"]="1"` 或 URL `?mock_reset=1` 会**清空并回到种子**，
 *    避免上一次手测留下的脏数据困住测试/下一轮开发。
 *
 * ## 重置入口（二选一，这里选 query 参数）
 * 浏览器地址后加 `?mock_reset=1` 刷新即可：清掉所有 `kaas-mock-v1:*` 键、回到种子，
 * 并把该参数从地址栏移除（否则每次刷新都会清）。开发时另可用
 * `localStorage.setItem("kaas-mock-fresh","1")` 达到同样效果（供 e2e/CI 显式声明）。
 *
 * ## 已知边界
 * 文件/公章等**二进制字节不持久化**（只需元数据即可驱动 UI；刷新后取图回落到占位 PNG）。
 * 这是刻意的：把图片 base64 塞进 localStorage 很快会撞 5MB 配额，而且真值本来在对象存储。
 */

export const MOCK_STORAGE_VERSION = 1;

const KEY_PREFIX = `kaas-mock-v${MOCK_STORAGE_VERSION}:`;
/** 下次加载时强制回到种子（e2e/CI 用；消费后自动删除） */
const FRESH_FLAG_KEY = "kaas-mock-fresh";
/** 显式重置入口：`?mock_reset=1` */
const RESET_QUERY_PARAM = "mock_reset";

type Snapshot = () => unknown;
type Restore = (value: unknown) => void;

const registry = new Map<string, { take: Snapshot; restore: Restore }>();

/** 注册一个可持久化集合（handler 模块在 import 期调用一次）。 */
export function registerMockCollection(
  name: string,
  take: Snapshot,
  restore: Restore,
): void {
  registry.set(name, { take, restore });
}

/** localStorage 可用性（SSR / 隐私模式 / 测试环境都可能不可用）。 */
function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    const store = window.localStorage;
    const probe = `${KEY_PREFIX}__probe`;
    store.setItem(probe, "1");
    store.removeItem(probe);
    return store;
  } catch {
    return null;
  }
}

export function isMockStorageAvailable(): boolean {
  return storage() !== null;
}

export function registeredMockCollections(): string[] {
  return [...registry.keys()];
}

/** 清掉**当前版本**的所有持久化键（不会动别的应用的键）。 */
export function clearMockPersistence(): void {
  const store = storage();
  if (!store) return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key && key.startsWith(KEY_PREFIX)) doomed.push(key);
    }
    for (const key of doomed) store.removeItem(key);
  } catch {
    // 配额/权限问题：清不掉也不影响本次内存态
  }
}

/** 标记"下次加载回到种子"（e2e/CI/开发显式清场用）。 */
export function markMockFreshOnNextLoad(): void {
  try {
    storage()?.setItem(FRESH_FLAG_KEY, "1");
  } catch {
    // 忽略
  }
}

/** 消费 `kaas-mock-fresh` 标记（存在则删掉并返回 true）。 */
export function consumeMockFreshFlag(): boolean {
  const store = storage();
  if (!store) return false;
  try {
    if (store.getItem(FRESH_FLAG_KEY) === "1") {
      store.removeItem(FRESH_FLAG_KEY);
      return true;
    }
  } catch {
    // 忽略
  }
  return false;
}

/** 消费 `?mock_reset=1`（存在则从地址栏移除并返回 true）。 */
export function consumeMockResetQuery(): boolean {
  if (typeof window === "undefined" || !window.location) return false;
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get(RESET_QUERY_PARAM) !== "1") return false;
    url.searchParams.delete(RESET_QUERY_PARAM);
    window.history.replaceState(window.history.state, "", url.toString());
    return true;
  } catch {
    return false;
  }
}

/** 读回持久化状态，逐集合 restore；版本不匹配/坏 JSON 一律删除该键（不灌坏数据）。 */
export function hydrateMockState(): string[] {
  const store = storage();
  if (!store) return [];
  const hydrated: string[] = [];
  for (const [name, { restore }] of registry) {
    const key = KEY_PREFIX + name;
    let raw: string | null = null;
    try {
      raw = store.getItem(key);
    } catch {
      raw = null;
    }
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as { v?: number; data?: unknown };
      if (parsed?.v !== MOCK_STORAGE_VERSION) {
        store.removeItem(key);
        continue;
      }
      restore(parsed.data);
      hydrated.push(name);
    } catch {
      try {
        store.removeItem(key);
      } catch {
        // 忽略
      }
    }
  }
  return hydrated;
}

/** 落盘指定集合（不传 = 全部已注册集合；写失败静默降级）。 */
export function persistMockState(names?: Iterable<string>): void {
  const store = storage();
  if (!store) return;
  const targets = names ?? registry.keys();
  for (const name of targets) {
    const entry = registry.get(name);
    if (!entry) continue;
    try {
      const data = entry.take();
      store.setItem(
        KEY_PREFIX + name,
        JSON.stringify({
          v: MOCK_STORAGE_VERSION,
          data,
          saved_at: new Date().toISOString(),
        }),
      );
    } catch {
      // 配额满 / 值不可序列化：不阻塞业务（内存态仍然正确）
    }
  }
}

/** 一次写请求会碰到的集合（按 URL 前缀 + 方法判定；GET 一律不落盘）。 */
interface WriteRule {
  match: RegExp;
  collections: string[];
}

const WRITE_RULES: readonly WriteRule[] = [
  { match: /\/customers(\/|$)/, collections: ["customers", "contacts", "inquiries", "stageLog", "inquiryStageLog", "counters"] },
  { match: /\/inquiries(\/|$)/, collections: ["inquiries", "inquiryStageLog", "counters"] },
  { match: /\/quotes(\/|$)/, collections: ["quotes", "counters"] },
  { match: /\/quotations(\/|$)/, collections: ["quotations"] },
  // A7 加固三集合（docFacts / docReceipts / docSet）都挂在 trade-docs 下：
  // 确认事实、登记收款、改单证清单都是单证域的写操作。
  { match: /\/trade-docs(\/|$)/, collections: ["docs", "docFileLinks", "contentVersions", "docFacts", "docReceipts", "docSet", "counters"] },
  { match: /\/file-objects(\/|$)/, collections: ["fileObjects", "counters"] },
  { match: /\/tenant-products(\/|$)/, collections: ["tenantProducts", "tenantProductStatus", "productProfiles", "fileObjects", "counters"] },
  { match: /\/tenant-product-status$/, collections: ["tenantProductStatus"] },
  { match: /\/products(\/|$)/, collections: ["fileObjects", "productProfiles", "counters"] },
  { match: /\/teams(\/|$)/, collections: ["team", "teamMembers", "teamInvites", "teamSubscriptions"] },
  { match: /\/tax-archives(\/|$)/, collections: ["taxArchives"] },
  { match: /\/product-tax-rates(\/|$)/, collections: ["productTaxRates"] },
  { match: /\/tenant\/company-profile$/, collections: ["companyProfile"] },
  { match: /\/tenant\/company-seals(\/|$)/, collections: ["companySeals"] },
  { match: /\/auth\//, collections: ["adminUser", "registeredEmails", "authResetToken"] },
  { match: /\/admin\/feature_flag$/, collections: ["featureFlags", "deploymentAudits"] },
  { match: /\/admin\/accounts(\/|$)/, collections: ["accounts"] },
  { match: /\/customer\/[^/]+\/capabilities$/, collections: ["capabilities"] },
  { match: /\/pricing-data(\/|$)/, collections: ["pricingCells"] },
  { match: /\/research(\/|$)/, collections: ["researchProducts", "researchRuns", "counters"] },
  { match: /\/leadgen(\/|$)/, collections: ["leadgenRuns", "leads", "counters"] },
  { match: /\/leads(\/|$)/, collections: ["leads", "inquiries", "counters"] },
  { match: /\/outreach(\/|$)/, collections: ["mailboxes", "campaigns", "messages", "counters"] },
  { match: /\/ai\/(providers|task-bindings)/, collections: ["aiProviders", "aiBindings"] },
  { match: /\/shipments(\/|$)/, collections: ["shipments", "counters"] },
  { match: /\/intel\/shipments(\/|$)/, collections: ["intelShipments", "counters"] },
  { match: /\/fx-rates$/, collections: ["fxRates"] },
  { match: /\/admin\/spec\/attribute-proposals/, collections: ["proposals"] },
  { match: /\/spec\/wizard/, collections: ["proposals", "skus", "counters"] },
];

/** 写请求 → 受影响的集合名（无匹配 = 该请求不改任何持久化 store）。 */
export function collectionsForRequest(
  method: string,
  url: string,
): string[] {
  const verb = method.toUpperCase();
  if (verb === "GET" || verb === "HEAD" || verb === "OPTIONS") return [];
  let path = url;
  try {
    path = new URL(url, "http://localhost").pathname;
  } catch {
    // 已经是相对路径：直接用
  }
  for (const rule of WRITE_RULES) {
    if (rule.match.test(path)) return rule.collections;
  }
  return [];
}

/** MSW 响应事件回调：把这次写请求碰到的集合落盘（resolver 已完成 ⇒ store 已是新值）。 */
export function persistAfterMockedResponse(
  method: string,
  url: string,
): void {
  const names = collectionsForRequest(method, url);
  if (names.length === 0) return;
  persistMockState(names);
}
