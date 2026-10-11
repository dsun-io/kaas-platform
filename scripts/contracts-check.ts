import { readFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { resolve } from 'path';

const REPO_ROOT = resolve(process.cwd(), '..');

function read(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf-8');
}

// ── R0: 3-way event_type consistency ──────────────────────────────────────

const KNOWN_EVENTS: readonly string[] = [
  'audit.access',
  'capability.update',
  'market.selected',
  'lead.discovered',
  'lead.enriched',
  'lead.outreach_ready',
  'outreach.sent',
  'outreach.replied',
  'quotation.converted',
  'order.shipped',
  'shipment.documented',
];

function extractFromTs(): string[] {
  const content = read('shared/contracts/events.ts');
  return KNOWN_EVENTS.filter((ev) => content.includes(`'${ev}'`)).sort();
}

function extractFromMd(): string[] {
  const content = read('shared/contracts/events.registry.md');
  const regex = /^##\s+(.+?)\s+\(v1\)/gm;
  return [...content.matchAll(regex)].map((m) => m[1].trim()).sort();
}

function extractFromPy(): string[] {
  const bePath = resolve(REPO_ROOT, 'backend/orchestrator/app/domain/schema_registry.py');
  if (!existsSync(bePath)) {
    return [];
  }
  const content = readFileSync(bePath, 'utf-8');
  const regex = /"([a-z]+\.[a-z_]+)"/g;
  return [...content.matchAll(regex)].map((m) => m[1]).sort();
}

// ── R1: Quote contract field consistency ───────────────────────────────────

/** Extract Pydantic class fields from quote_v2.py */
function extractQuotePyFields(): Map<string, string[]> {
  const content = read('backend/orchestrator/app/schemas/quote_v2.py');
  const result = new Map<string, string[]>();
  const classRe = /^class (\w+)\(BaseModel\):/gm;
  let match: RegExpExecArray | null;
  while ((match = classRe.exec(content)) !== null) {
    const className = match[1];
    const fields: string[] = [];
    const classStart = match.index;
    const remaining = content.slice(classStart + 1);
    const nextClass = remaining.search(/\nclass \w+\(/);
    const classEnd = nextClass === -1 ? content.length : classStart + 1 + nextClass;
    const classBody = content.slice(classStart, classEnd);
    const fieldRe = /^\s+(\w+)\s*:/gm;
    let fm: RegExpExecArray | null;
    while ((fm = fieldRe.exec(classBody)) !== null) {
      fields.push(fm[1]);
    }
    if (fields.length > 0) {
      result.set(className, fields.sort());
    }
  }
  return result;
}

/** Extract Zod schema fields from quote.ts */
function extractQuoteTsFields(): Map<string, string[]> {
  const content = read('shared/contracts/quote.ts');
  const result = new Map<string, string[]>();
  const schemaRe = /^export const (\w+)Schema\s*=\s*z\.object\(\{/gm;
  let match: RegExpExecArray | null;
  while ((match = schemaRe.exec(content)) !== null) {
    const name = match[1];
    const fields: string[] = [];
    const bodyStart = match.index + match[0].length;
    let braceDepth = 1;
    let closeIdx = -1;
    for (let i = bodyStart; i < content.length; i++) {
      if (content[i] === '{') {
        braceDepth++;
      } else if (content[i] === '}') {
        braceDepth--;
        if (braceDepth === 0) {
          closeIdx = i;
          break;
        }
      }
    }
    if (closeIdx !== -1) {
      const body = content.slice(bodyStart, closeIdx);
      const fieldRe = /^\s+(\w+)\s*:/gm;
      let fm: RegExpExecArray | null;
      while ((fm = fieldRe.exec(body)) !== null) {
        fields.push(fm[1]);
      }
    }
    if (fields.length > 0) {
      result.set(name, fields.sort());
    }
  }
  return result;
}

// ── Schema name mapping: Zod name -> Pydantic class name ──────────────────

const ZOD_TO_PY: Record<string, string> = {
  QuoteV2Request: 'QuoteV2Request',
  AccessoryRequest: 'AccessoryRequest',
  TierItem: 'TierItem',
  FreightOption: 'FreightOption',
  FreightInfo: 'FreightInfo',
  MainLine: 'MainLine',
  AccessoryLine: 'AccessoryLine',
  Totals: 'Totals',
  QuoteV2Response: 'QuoteV2Response',
};

// ── R2: 工位元数据（shared/contracts/workstations.ts ↔ 后端镜像） ────────

interface WsEntry {
  name: string;
  route: string;
  status: string;
}

/** 从 workstations.ts 的 WORKSTATIONS 数组提取 {key -> {name,route,status}} */
function extractWorkstationsTs(): Map<string, WsEntry> {
  const content = read('shared/contracts/workstations.ts');
  const start = content.indexOf('export const WORKSTATIONS');
  if (start === -1) return new Map();
  const body = content.slice(start);
  const result = new Map<string, WsEntry>();
  const objRe = /\{([^{}]*)\}/g; // 工位对象内部无嵌套花括号
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(body)) !== null) {
    const o = m[1];
    const key = /\bkey:\s*'([^']+)'/.exec(o)?.[1];
    const name = /\bname:\s*'([^']+)'/.exec(o)?.[1];
    const route = /\broute:\s*'([^']+)'/.exec(o)?.[1];
    const status = /\bstatus:\s*'([^']+)'/.exec(o)?.[1];
    if (key && name && route && status) result.set(key, { name, route, status });
  }
  return result;
}

/** 从 workstations.py 的 WORKSTATIONS 列表提取同名映射 */
function extractWorkstationsPy(): Map<string, WsEntry> {
  const content = read('backend/orchestrator/app/domain/workstations.py');
  const start = content.indexOf('WORKSTATIONS = [');
  if (start === -1) return new Map();
  const body = content.slice(start);
  const result = new Map<string, WsEntry>();
  const objRe = /\{([\s\S]*?)\}/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(body)) !== null) {
    const o = m[1];
    const key = /"key":\s*"([^"]+)"/.exec(o)?.[1];
    const name = /"name":\s*"([^"]+)"/.exec(o)?.[1];
    const route = /"route":\s*"([^"]+)"/.exec(o)?.[1];
    const status = /"status":\s*"([^"]+)"/.exec(o)?.[1];
    if (key && name && route && status) result.set(key, { name, route, status });
  }
  return result;
}

// ── R3: 单证类型清单（前端模板 ↔ 后端枚举字典 ↔ 编号前缀）───────────────
// 为什么需要：这三份清单必须同时包含同一批单证类型。
//   模板有而字典没有 → 业务上“该类单证开不出来”；
//   字典有而模板没有 → 开得出单据但渲染不出（印出来是空白）；
//   编号前缀漏登记   → 单号退化成前三位大写，变成 SA-202609-0001 这种无含义编号。
// 三个都校对上，才能真正避免“菜单有、能力没有”的老问题。

function extractManifestDocTypes(): string[] {
  const manifest = JSON.parse(read('frontend/src/lib/trade-doc/manifest.json')) as Record<
    string,
    unknown
  >;
  return Object.keys(manifest);
}

/** 抓取 Python 具名元组里的字符串元素：NAME = ( "a", "b", ) */
function extractPyTuple(name: string): string[] {
  const content = read('backend/orchestrator/app/domain/enums.py');
  const start = content.indexOf(`${name} = (`);
  if (start === -1) return [];
  const close = content.indexOf(')', start);
  if (close === -1) return [];
  const body = content.slice(start, close);
  const values: string[] = [];
  for (const m of body.matchAll(/"([^"]+)"/g)) values.push(m[1]);
  return values;
}

/** 抓取 DOC_TYPE_PREFIX = { "type": "PFX", ... } 的键 */
function extractDocTypePrefixKeys(): string[] {
  const content = read('backend/orchestrator/app/api/ws_common.py');
  const start = content.indexOf('DOC_TYPE_PREFIX');
  if (start === -1) return [];
  const close = content.indexOf('}', start);
  if (close === -1) return [];
  const body = content.slice(start, close);
  const keys: string[] = [];
  for (const m of body.matchAll(/"([^"]+)"\s*:/g)) keys.push(m[1]);
  return keys;
}

// ── R4: 线上 Worker 镜像一致性 ────────────────────────────────────────────
// 为什么需要：本项目架构是「orchestrator 开发 → 手工同步到 worker/main.py 单文件上线」。
// 【手工同步】就是漏同步的来源：本地能开单、线上报 422；或本地去掉某个类型、线上还能开。
// 所以把三份东西钉死：单证类型集合、编号前缀覆盖、单号字段映射（两侧逐项相等）。

function pyTupleFrom(content: string, name: string): string[] {
  const start = content.indexOf(`${name} = (`);
  if (start === -1) return [];
  const close = content.indexOf(')', start);
  if (close === -1) return [];
  return [...content.slice(start, close).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function pyDictKeysFrom(content: string, name: string): string[] {
  // 允许类型注解形式（NAME: dict[...] = { ... }）：直接找名字之后的第一个 {
  const nameAt = content.indexOf(`${name}`);
  if (nameAt === -1) return [];
  const start = content.indexOf('{', nameAt);
  if (start === -1) return [];
  const close = content.indexOf('}', start);
  if (close === -1) return [];
  return [...content.slice(start, close).matchAll(/"([^"]+)"\s*:/g)].map((m) => m[1]);
}

/** 定位**模块级字典的定义体**（`NAME = {` … 行首 `}`）。
 *
 * 为什么不用「首次出现 NAME」：名字在 `__all__` / `import` 里也会出现，
 * 按「名字之后的第一个 `{`」去解析会抓到无关代码块 —— 这正是 2026-10-11
 * 修掉的那个 bug（DOC_NO_FIELDS 下沉共享内核后，旧实现既误报又漏检）。 */
function pyDictBody(content: string, name: string): string | null {
  const m = new RegExp(`^${name}\\s*(?::[^=\\n]+)?=\\s*\\{`, 'm').exec(content);
  if (!m) return null;
  const open = content.indexOf('{', m.index);
  if (open === -1) return null;
  const close = content.indexOf('\n}', open);
  return content.slice(open, close === -1 ? undefined : close);
}

/** 该模块是否**自己定义**了 NAME（而不是从共享内核 import）。
 *  用于抓「适配层又抄一份回来」——漂移的起点。 */
function redefines(content: string, name: string): boolean {
  return new RegExp(`^${name}\\s*(?::[^=\\n]+)?=`, 'm').test(content);
}

// ── R5: admin 端点响应键集合（前端消费契约 ↔ orchestrator ↔ worker）────────
//
// 为什么需要（有实测证据）：/admin/tenants、/admin/tenants/reload、
// /admin/feature_flag 长期**三方不一致**（orchestrator 用 display_name/enabled、
// worker 用 items/name、前端 hook 用 name），而 route-parity.py **只比对路径存在性**、
// R0–R4 **不覆盖 admin 端点** ⇒ 没有任何门禁能发现它；生产是 real 模式
// （frontend/.env.production:1）⇒ 租户名空白 / 状态恒停用 / 点重载崩 / 灰度开关恒 OFF。
// 详见 docs/ADMIN_TENANTS_CONTRACT_REPORT.md。
//
// 期望形状 = 2026-10-11 用户裁决「以前端消费契约为准」（P2 统一 display_name，
// P4 reload 必须返回租户清单）。**现行偏差登记在** scripts/contracts-allowlist.txt：
// 登记在案的不失败；未登记的新偏差失败；**修好后忘删登记也失败**（棘轮，双向生效）。
//
// 取键方式与 R1/R2 一致：**解析源码结构**（定位装饰器 → 取 return 字面量 → 按花括号
// 深度分「包封键 / 条目键」），不用「关键字 grep」当证据。

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uniq(list: string[]): string[] {
  return [...new Set(list)];
}

/** 下标 idx 之前的花括号净深度（`{` +1 / `}` -1）。 */
function braceDepthAt(s: string, idx: number): number {
  let depth = 0;
  for (let i = 0; i < idx; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') depth--;
  }
  return depth;
}

interface PyHandlerKeys {
  /** 深度 1 的键：包封键（如 tenants / items） */
  envelope: string[];
  /** 深度 2 的键：条目键（如 tenant_id / display_name） */
  item: string[];
  shape: 'literal' | 'dynamic-map' | 'missing';
}

/** 抽出 python handler 的**函数体**（装饰器之后 → 下一个顶层装饰器之前）。
 *
 * 不解析 router 前缀：调用方直接给出**文件内出现的路由字面量**
 * （orchestrator 的 router 带 prefix、worker 是完整路径），省掉一套 prefix 拼接。 */
function pyHandlerBody(
  src: string,
  method: string,
  route: string,
): string | null {
  const re = new RegExp(
    `@(?:router|app)\\.${method}\\(\\s*"${escapeRegExp(route)}"`,
  );
  const m = re.exec(src);
  if (!m) return null;
  const start = m.index + m[0].length;
  // handler 体：到下一个顶层装饰器（或文件末尾）
  const nextDeco = /\n@(?:router|app)\./.exec(src.slice(start));
  return src.slice(start, nextDeco ? start + nextDeco.index : src.length);
}

/** 从 python handler 的 `return {...}` 字面量取「包封键 + 条目键」。
 *
 * 为什么按**花括号深度**取：`return {"items": [{"tenant_id": ..., "name": ...}]}`
 * 里 `items` 是包封键、后面两个是条目键；只看「出现的所有 `"x":`」会把两层混成一个集合，
 * 于是「包封键从 tenants 变成 items」这种漂移反而看不出来。
 * `t.get("display_name")` 这类调用不是 `"key":` 形式，天然不会误入。 */
function pyHandlerKeys(src: string, method: string, route: string): PyHandlerKeys {
  const empty: PyHandlerKeys = { envelope: [], item: [], shape: 'missing' };
  const body = pyHandlerBody(src, method, route);
  if (body === null) return empty;

  const retAt = body.indexOf('return {');
  if (retAt === -1) return empty;
  const open = body.indexOf('{', retAt);
  let depth = 0;
  let close = -1;
  for (let i = open; i < body.length; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  const expr = body.slice(open, close === -1 ? body.length : close + 1);

  const envelope: string[] = [];
  const item: string[] = [];
  for (const km of expr.matchAll(/"([A-Za-z_]\w*)"\s*:/g)) {
    const d = braceDepthAt(expr, km.index);
    if (d === 1) envelope.push(km[1]);
    else if (d === 2) item.push(km[1]);
  }
  // 字典推导 `{tid: t.get("feature_flags", {}) for tid, t in tenants.items()}`
  // 的键是**动态的**（tenant_id → flags 映射）—— 这正是 R5.3 期望的形状，记为 dynamic-map。
  // 判据用「深度 1 有没有字面量键」，而不是「有没有 for」：GET /tenants 的列表推导里
  // 也含 `for ... in ...`，但它有字面量包封键 `tenants`。
  if (envelope.length === 0 && /\bfor\b[\s\S]*?\bin\b/.test(expr)) {
    return { envelope: [], item: [], shape: 'dynamic-map' };
  }
  return { envelope: uniq(envelope), item: uniq(item), shape: 'literal' };
}

/** 从 python handler 体里取它**读取的请求体键**（R5 请求体规则用）。
 *
 * 只认三种**结构性读取**形态：`body.get("x")` / `body["x"]` / `"x" in body` ——
 * 命中即"这一行真的从请求体取了这个键"，而不是在注释/文档字符串里出现过该词。 */
function pyBodyReadKeys(body: string): string[] {
  const keys: string[] = [];
  for (const m of body.matchAll(/body\.get\(\s*"([A-Za-z_]\w*)"/g)) {
    keys.push(m[1]);
  }
  for (const m of body.matchAll(/body\[\s*"([A-Za-z_]\w*)"\s*\]/g)) {
    keys.push(m[1]);
  }
  for (const m of body.matchAll(/"([A-Za-z_]\w*)"\s+in\s+body/g)) {
    keys.push(m[1]);
  }
  return uniq(keys);
}

/** 取 TS 里 `anchor(...)` 之后那个对象字面量的**顶层键**
 *  （R5 请求体规则用：前端调用点**实际发出**的键）。 */
function tsObjectLiteralKeys(src: string, anchor: string): string[] {
  const at = src.indexOf(anchor);
  if (at === -1) return [];
  const open = src.indexOf('{', at);
  if (open === -1) return [];
  let depth = 0;
  let close = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  const expr = src.slice(open, close === -1 ? src.length : close + 1);
  const keys: string[] = [];
  for (const m of expr.matchAll(/^\s*([A-Za-z_]\w*)\s*:/gm)) {
    if (braceDepthAt(expr, m.index) === 1) keys.push(m[1]);
  }
  return uniq(keys);
}

/** 取 TS interface 的**顶层**字段名（缩进 2 空格的行），可选字段（`x?:`）也算。 */
function tsInterfaceFields(src: string, iface: string): string[] {
  const re = new RegExp(
    `(?:export\\s+)?interface\\s+${escapeRegExp(iface)}\\b[^{]*\\{`,
  );
  const m = re.exec(src);
  if (!m) return [];
  const open = src.indexOf('{', m.index);
  let depth = 0;
  let close = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  const body = src.slice(open + 1, close === -1 ? src.length : close);
  const fields: string[] = [];
  for (const line of body.split('\n')) {
    const fm = /^\s{2}(\w+)\??\s*:/.exec(line);
    if (fm) fields.push(fm[1]);
  }
  return uniq(fields);
}

/** 取 `call<T>(...)` 的泛型实参文本（配平 `<>`，规范化空白）。 */
function tsGenericArg(src: string, call: string): string | null {
  const at = src.indexOf(`${call}<`);
  if (at === -1) return null;
  const open = at + call.length;
  let depth = 0;
  let close = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '<') depth++;
    else if (src[i] === '>') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return null;
  return src.slice(open + 1, close).replace(/\s+/g, ' ').trim();
}

function sameKeySet(a: string[], b: string[]): boolean {
  return [...a].sort().join(',') === [...b].sort().join(',');
}

type R5Source =
  | {
      side: string;
      kind: 'handler';
      file: string;
      method: 'get' | 'post';
      route: string;
    }
  | {
      side: string;
      kind: 'ts-interface';
      file: string;
      iface: string;
      /** 该 interface 描述的是「包封」（如 TenantListResponse/ReloadResult）
       *  还是「条目」（如 Tenant）——两者期望集合不同，必须显式声明。 */
      compares: 'envelope' | 'item';
    }
  | { side: string; kind: 'generic'; file: string; call: string };

interface R5Rule {
  id: string;
  label: string;
  expectedEnvelope: string[];
  expectedItem?: string[];
  expectedGeneric?: string;
  sources: R5Source[];
}

const R5_RULES: R5Rule[] = [
  {
    id: 'R5.1',
    label: 'GET /api/v1/admin/tenants',
    expectedEnvelope: ['tenants'],
    expectedItem: ['tenant_id', 'display_name', 'is_active'],
    sources: [
      {
        side: 'orchestrator',
        kind: 'handler',
        file: 'backend/orchestrator/app/api/admin.py',
        method: 'get',
        route: '/tenants',
      },
      {
        side: 'worker',
        kind: 'handler',
        file: 'backend/worker/src/main.py',
        method: 'get',
        route: '/api/v1/admin/tenants',
      },
      {
        side: 'frontend-api',
        kind: 'ts-interface',
        file: 'frontend/src/app/(app)/settings/hooks/use-tenants.ts',
        iface: 'Tenant',
        compares: 'item',
      },
      {
        side: 'frontend-list',
        kind: 'ts-interface',
        file: 'frontend/src/app/(app)/settings/hooks/use-tenants.ts',
        iface: 'TenantListResponse',
        compares: 'envelope',
      },
      {
        side: 'frontend-view',
        kind: 'ts-interface',
        file: 'frontend/src/app/(app)/settings/components/types.ts',
        iface: 'Tenant',
        compares: 'item',
      },
    ],
  },
  {
    id: 'R5.2',
    label: 'POST /api/v1/admin/tenants/reload',
    expectedEnvelope: ['reloaded_count', 'active_tenants'],
    expectedItem: ['tenant_id', 'display_name', 'locale', 'region', 'is_active'],
    sources: [
      {
        side: 'orchestrator',
        kind: 'handler',
        file: 'backend/orchestrator/app/api/admin.py',
        method: 'post',
        route: '/tenants/reload',
      },
      {
        side: 'worker',
        kind: 'handler',
        file: 'backend/worker/src/main.py',
        method: 'post',
        route: '/api/v1/admin/tenants/reload',
      },
      {
        side: 'frontend-api',
        kind: 'ts-interface',
        file: 'frontend/src/app/(app)/settings/hooks/use-tenants.ts',
        iface: 'ReloadResult',
        compares: 'envelope',
      },
      {
        side: 'frontend-view',
        kind: 'ts-interface',
        file: 'frontend/src/app/(app)/settings/components/types.ts',
        iface: 'ReloadResult',
        compares: 'envelope',
      },
    ],
  },
  {
    id: 'R5.3',
    label: 'GET /api/v1/admin/feature_flag',
    expectedEnvelope: [],
    expectedGeneric: 'Record<string, Record<string, boolean>>',
    sources: [
      {
        side: 'orchestrator',
        kind: 'handler',
        file: 'backend/orchestrator/app/api/admin.py',
        method: 'get',
        route: '/feature_flag',
      },
      {
        side: 'worker',
        kind: 'handler',
        file: 'backend/worker/src/main.py',
        method: 'get',
        route: '/api/v1/admin/feature_flag',
      },
      {
        side: 'frontend-api',
        kind: 'generic',
        file: 'frontend/src/app/(app)/admin/gray-release/hooks/use-feature-flags.ts',
        call: 'apiClient.get',
      },
    ],
  },
];

// ── R5 · 请求体形状 ───────────────────────────────────────────────────────
// 为什么单开一组：上面 R5.1–R5.3 比的是**响应**键集合；而 worker
// `POST /admin/feature_flag` 曾是真缺陷 —— 它只认后端格式 `flag_name`，前端发的是
// `{tenant_id, flag_key, enabled, reason, actor_id}` ⇒ real 模式下点灰度开关 **422**
// （0a66e9b 修：加别名兼容）。**这类缺陷 R5 的响应比对完全看不到** ⇒ 需要请求体规则。
//
// 语义（三方）：
//   · 前端调用点**实际发出的键** S（解析 `mutateAsync({...})` 的对象字面量）；
//   · 每个后端 handler **读取的请求体键** B（解析 `body.get("x")` / `body["x"]` / `"x" in body`）；
//   · 声明一个「必须被接受」的键集合 K（像 R0 的 KNOWN_EVENTS 一样写在脚本里）。
//   失败条件：K ⊄ S（前端没发）或 K ⊄ B（后端不认）—— 后者正是那次 422 的形状。
//   前端多发、后端不读的键（如审计上下文 `actor_id`）**只打印 INFO，不算偏差**：
//   worker 用登录用户 id 代替 actor_id 是有意为之。

interface R5BodyRule {
  id: string;
  label: string;
  /** 上游契约里「缺一个就会让操作失效」的键 */
  requiredKeys: string[];
  frontend: { side: string; file: string; anchor: string };
  backends: Array<{
    side: string;
    file: string;
    method: 'get' | 'post';
    route: string;
  }>;
}

const R5_BODY_RULES: R5BodyRule[] = [
  {
    id: 'R5.4',
    label: 'POST /api/v1/admin/feature_flag 请求体键集合',
    // 为什么是这三个：frontend/src/app/(app)/admin/gray-release/components/flag-toggle.tsx:32-38
    // 发的 5 个键里，tenant_id / flag_key / enabled 是**操作语义**（哪个租户、哪个开关、开还是关）；
    // reason / actor_id 是审计上下文（worker 用登录用户 id 替代 actor_id，故不列为必需）。
    requiredKeys: ['tenant_id', 'flag_key', 'enabled'],
    frontend: {
      side: 'frontend-release',
      file: 'frontend/src/app/(app)/admin/gray-release/components/flag-toggle.tsx',
      anchor: 'mutateAsync(',
    },
    backends: [
      {
        side: 'orchestrator',
        file: 'backend/orchestrator/app/api/admin.py',
        method: 'post',
        route: '/feature_flag',
      },
      {
        side: 'worker',
        file: 'backend/worker/src/main.py',
        method: 'post',
        route: '/api/v1/admin/feature_flag',
      },
    ],
  },
];

// ── R6: openapi.json 新鲜度（基准 = 已提交的 HEAD 快照）──────────────────
//
// 为什么：backend/orchestrator/docs/openapi.json 陈旧过 14 小时（10:43 的产物），
// 0a66e9b 已统一 /admin/tenants 契约而它仍写着 enabled/tenant_count；**没有任何校验**
// ⇒ 漂移无人发现。刷新那一次实测 79 → 171 paths、48 → 115 schemas。
//
// 基准怎么取（task-17 要求 2）：**两侧都取 HEAD**，都用 `git show HEAD:<path>` ——
// 工作树里 backend/orchestrator/app/** 经常有别人的半成品（实测 files.py/trade_docs.py），
// 拿工作树当基准就等于把半成品当成"当前契约"。task-17 原文也把 `git show HEAD:<file>`
// 列为可接受的取基准方式。
//
// 比什么是结构化的（不逐字节比文件）：
//   R6.1 路径集合：HEAD 源码的路由装饰器 + `APIRouter(prefix=)` → 完整 path 集合。
//        跳过 `include_in_schema=False`（FastAPI 注册但**不进 schema**，实测 4 条 alias 路由）；
//        非装饰器注入的路径走**声明式例外**（R6_NON_DECORATOR_PATHS）。
//   R6.2 每个 path 的 HTTP 方法集合。
//   R6.3 `response_model=X` 的路由：artifact 的 2xx 响应必须 $ref 到 X。
//   R6.4 Pydantic 模型字段键集合（`class X(BaseModel)`，含 `alias=`）↔
//        `components.schemas[X].properties`；同名类多处定义时**任一处一致即算一致**。
//
// 为什么不是「跑 app.main 生成再比」：contracts-check.yml 只装 node/pnpm（无 Python/FastAPI），
// 生成式比对在 CI 里只能 WARN+跳过 —— 而 CI 正是门禁必须生效的地方；且本工作区
// app/** 常被并发编辑，从工作树生成会把半成品固化。结构解析两侧都取 HEAD：无环境依赖、
// 无跳过分支、CI 可跑。解析器已用"当前 171 paths / 103 模型**零差异**"自校验。

const R6_BASELINE_REV = 'HEAD';
const R6_ARTIFACT = { rev: 'HEAD', path: 'backend/orchestrator/docs/openapi.json' };
const R6_APP_DIR = 'backend/orchestrator/app';
/** 非装饰器注入的路径（源码里没有对应 `@router/@app` 装饰器）：
 *  `/metrics` 由 app/main.py 的 `setup_metrics(app)`（app/core/metrics.py）注入。 */
const R6_NON_DECORATOR_PATHS = ['/metrics'];
/** FastAPI 自动生成、或 UploadFile 参数产生的 schema，源码里没有同名类 */
function r6SkipSchema(name: string): boolean {
  return (
    name === 'HTTPValidationError' ||
    name === 'ValidationError' ||
    name.startsWith('Body_')
  );
}

/** `git show <rev>:<path>`。
 *  `rev === ''` 或 path 是绝对路径时退化为直接读文件 —— 仅用于自证/临时指向副本。 */
function readAtRev(rev: string, path: string): string {
  if (rev === '' || /^([A-Za-z]:[\\/]|\/)/.test(path)) {
    return readFileSync(resolve(REPO_ROOT, path), 'utf-8');
  }
  return execFileSync('git', ['-C', REPO_ROOT, 'show', `${rev}:${path}`], {
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function gitLsTreeAt(rev: string, dir: string): string[] {
  return execFileSync(
    'git',
    ['-C', REPO_ROOT, 'ls-tree', '-r', '--name-only', rev, dir],
    { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
  )
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** 括号配平（跳过字符串字面量）—— python 装饰器常跨行、参数里还有嵌套括号。 */
function matchingParen(text: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < text.length && text[i] !== q) {
        if (text[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 模块级 `APIRouter(prefix="...")` 的前缀；没有 prefix（health/prices）→ ""。 */
function pyRouterPrefix(src: string): string {
  const at = src.indexOf('APIRouter(');
  if (at === -1) return '';
  const open = src.indexOf('(', at);
  const end = matchingParen(src, open);
  const args = src.slice(open + 1, end === -1 ? src.length : end);
  const m = /prefix\s*=\s*"([^"]*)"/.exec(args);
  return m ? m[1] : '';
}

interface PyRoute {
  method: string;
  path: string;
  args: string;
}

function pyRoutes(src: string): PyRoute[] {
  const out: PyRoute[] = [];
  for (const m of src.matchAll(
    /@(?:router|app)\.(get|post|put|patch|delete)\(/g,
  )) {
    const open = m.index + m[0].length - 1;
    const end = matchingParen(src, open);
    const args = src.slice(open + 1, end === -1 ? src.length : end);
    const pm = /^\s*"([^"]*)"/.exec(args);
    if (!pm) continue;
    out.push({ method: m[1].toUpperCase(), path: pm[1], args });
  }
  return out;
}

/** `class X(BaseModel)` 的顶层字段键（有 `alias=` 时取别名；openapi 用别名做属性名）。 */
function pyModelFields(src: string): Map<string, string[]> {
  const res = new Map<string, string[]>();
  for (const m of src.matchAll(/^class (\w+)\(BaseModel\):/gm)) {
    // class body：到下一个顶层语句（行首非空白）为止 —— 否则会把后面的函数体当字段
    const after = src.slice(m.index + m[0].length);
    const stop = after.search(/\n(?=\S)/);
    const body = stop === -1 ? after : after.slice(0, stop);
    const fields: string[] = [];
    for (const line of body.split('\n')) {
      const fm = /^ {4}(\w+)\s*:/.exec(line);
      if (!fm) continue;
      const alias = /alias\s*=\s*"([^"]+)"/.exec(line);
      fields.push(alias ? alias[1] : fm[1]);
    }
    if (fields.length > 0) res.set(m[1], uniq(fields));
  }
  return res;
}

interface R6Artifact {
  paths?: Record<string, Record<string, unknown>>;
  components?: {
    schemas?: Record<string, { properties?: Record<string, unknown> }>;
  };
}

// ── Main ───────────────────────────────────────────────────────────────────

let allOk = true;

const ts = extractFromTs();
const md = extractFromMd();
const py = extractFromPy();

const tsJson = JSON.stringify(ts);
const mdJson = JSON.stringify(md);
const pyJson = JSON.stringify(py);

if (!existsSync(resolve(REPO_ROOT, 'backend/orchestrator/app/domain/schema_registry.py'))) {
  console.warn('WARN: schema_registry.py not found, skip R0');
} else if (tsJson !== mdJson || mdJson !== pyJson) {
  allOk = false;
  console.error('FAIL R0: event_type mismatch across 3 sources');
  if (tsJson !== mdJson) {
    console.error('  events.ts:              ' + ts.join(', '));
    console.error('  events.registry.md:     ' + md.join(', '));
    console.error('  => events.ts does not match events.registry.md');
  }
  if (mdJson !== pyJson) {
    console.error('  events.registry.md:     ' + md.join(', '));
    console.error('  schema_registry.py:     ' + py.join(', '));
    console.error('  => events.registry.md does not match schema_registry.py');
  }
} else {
  console.log('PASS R0: ' + ts.length + ' event_types, 3 sources consistent');
  console.log('       ' + ts.join(', '));
}

const tsFields = extractQuoteTsFields();
const pyFields = extractQuotePyFields();

for (const [zodName, pyName] of Object.entries(ZOD_TO_PY)) {
  const tsF = tsFields.get(zodName);
  const pyF = pyFields.get(pyName);
  if (!tsF) {
    allOk = false;
    console.error('FAIL R1: quote.ts missing schema ' + zodName);
    continue;
  }
  if (!pyF) {
    allOk = false;
    console.error('FAIL R1: quote_v2.py missing class ' + pyName);
    continue;
  }
  const tsSet = new Set(tsF);
  const pySet = new Set(pyF);
  const onlyTs = tsF.filter((f) => !pySet.has(f));
  const onlyPy = pyF.filter((f) => !tsSet.has(f));
  if (onlyTs.length > 0 || onlyPy.length > 0) {
    allOk = false;
    console.error('FAIL R1: field mismatch in ' + zodName);
    if (onlyTs.length) console.error('  quote.ts only:   ' + onlyTs.join(', '));
    if (onlyPy.length) console.error('  quote_v2.py only: ' + onlyPy.join(', '));
  }
}

if (allOk) {
  console.log('PASS R1: ' + Object.keys(ZOD_TO_PY).length + ' schemas match');
}

// ── R2: 工位元数据一致性 ────────────────────────────────────────────────
// 为什么需要：页面名曾有多处来源并产生过真实不一致（面包屑 /market 写成「市场调研」，
// 与工位「市场调研」重名；4 个工位漏登记显示英文 slug）。
// 契约建立后若两侧漂移，就会出现「菜单有但后端没有」或反向的情况 ——
// 即团队反复踩的「遗漏 / 不同步」。本规则使漂移直接 CI 失败。
const wsTs = extractWorkstationsTs();
const wsPy = extractWorkstationsPy();

if (wsTs.size === 0 || wsPy.size === 0) {
  allOk = false;
  console.error('FAIL R2: 无法解析工位清单（ts=' + wsTs.size + ', py=' + wsPy.size + '）');
} else {
  const onlyTs = [...wsTs.keys()].filter((k) => !wsPy.has(k));
  const onlyPy = [...wsPy.keys()].filter((k) => !wsTs.has(k));
  if (onlyTs.length || onlyPy.length) {
    allOk = false;
    console.error('FAIL R2: 工位 key 不一致');
    if (onlyTs.length) console.error('  仅前端有: ' + onlyTs.join(', '));
    if (onlyPy.length) console.error('  仅后端有: ' + onlyPy.join(', '));
  } else {
    const diffs: string[] = [];
    for (const [k, a] of wsTs) {
      const b = wsPy.get(k)!;
      if (a.name !== b.name) diffs.push(k + '.name: ts="' + a.name + '" py="' + b.name + '"');
      if (a.route !== b.route) diffs.push(k + '.route: ts="' + a.route + '" py="' + b.route + '"');
      if (a.status !== b.status) diffs.push(k + '.status: ts="' + a.status + '" py="' + b.status + '"');
    }
    if (diffs.length) {
      allOk = false;
      console.error('FAIL R2: 字段不一致');
      diffs.forEach((d) => console.error('  ' + d));
    } else {
      console.log('PASS R2: ' + wsTs.size + ' workstations consistent (ts <-> py)');
    }
  }
}

// ── R3: 单证类型三方一致 ────────────────────────────────────────────────
const manifestDocTypes = extractManifestDocTypes().sort();
const pyDocTypes = extractPyTuple('DOC_TYPE').sort();
const prefixKeys = extractDocTypePrefixKeys();

if (manifestDocTypes.length === 0 || pyDocTypes.length === 0) {
  allOk = false;
  console.error(
    'FAIL R3: 无法解析单证类型清单（manifest=' +
      manifestDocTypes.length +
      ', py=' +
      pyDocTypes.length +
      '）',
  );
} else {
  const onlyTpl = manifestDocTypes.filter((t) => !pyDocTypes.includes(t));
  const onlyEnum = pyDocTypes.filter((t) => !manifestDocTypes.includes(t));
  const noPrefix = pyDocTypes.filter((t) => !prefixKeys.includes(t));

  if (onlyTpl.length || onlyEnum.length) {
    allOk = false;
    console.error('FAIL R3: 单证模板清单与后端类型字典不一致');
    if (onlyTpl.length) console.error('  仅模板有（该类型开不出单）: ' + onlyTpl.join(', '));
    if (onlyEnum.length) console.error('  仅字典有（开得出但渲染不出）: ' + onlyEnum.join(', '));
  }
  if (noPrefix.length) {
    allOk = false;
    console.error('FAIL R3: 单证类型未登记编号前缀（单号会退化成前三位大写）: ' + noPrefix.join(', '));
  }
  if (!onlyTpl.length && !onlyEnum.length && !noPrefix.length) {
    console.log('PASS R3: ' + manifestDocTypes.length + ' doc types consistent (tpl <-> enum <-> prefix)');
  }
}

// ── R4: 线上 Worker 镜像 ────────────────────────────────────────────────
const workerSrc = read('backend/worker/src/main.py');
const workerDocTypes = pyTupleFrom(workerSrc, 'DOC_TYPE_SET').sort();
const workerPrefixes = pyDictKeysFrom(workerSrc, 'DOC_TYPE_PREFIX');
// 单号字段映射已下沉为**单一来源**（kaas_common/trade_doc/payload_shared.py）。
// 旧实现分别从 worker/main.py 与 trade_doc_payload.py 解析 —— 下沉后两处只剩 import，
// 解析器抓到无关代码块：既误报「会把合同号印成发票号」，又完全测不到真正要防的漂移。
// 现改为三条能真正生效的检查（2026-10-11 重写）：
//   1. 共享内核的 DOC_NO_FIELDS 必须覆盖全部单证类型（缺 → 单号静默退化）
//   2. 任一适配层**不得再定义** DOC_NO_FIELDS（只许 import，防抄回一份）
//   3. 保留 worker 侧 DOC_TYPE_SET / DOC_TYPE_PREFIX 两条（它们仍在 main.py 里定义，有效）
const SHARED_PAYLOAD = 'backend/kaas_common/trade_doc/payload_shared.py';
const NO_FIELDS_ADAPTERS = [
  'backend/worker/src/main.py',
  'backend/orchestrator/app/services/trade_doc_payload.py',
];
const sharedNoFieldsBody = pyDictBody(read(SHARED_PAYLOAD), 'DOC_NO_FIELDS');
const sharedNoFieldKeys = sharedNoFieldsBody
  ? [...sharedNoFieldsBody.matchAll(/"([a-z_]+)"\s*:/g)].map((m) => m[1])
  : [];
const noFieldsMissing = pyDocTypes.filter((t) => !sharedNoFieldKeys.includes(t));
const noFieldsShadowed = NO_FIELDS_ADAPTERS.filter((p) => redefines(read(p), 'DOC_NO_FIELDS'));

if (workerDocTypes.length === 0) {
  allOk = false;
  console.error('FAIL R4: 无法从 worker/main.py 解析 DOC_TYPE_SET');
} else {
  const workerOnly = workerDocTypes.filter((t) => !pyDocTypes.includes(t));
  const localOnly = pyDocTypes.filter((t) => !workerDocTypes.includes(t));
  const workerNoPrefix = workerDocTypes.filter((t) => !workerPrefixes.includes(t));

  if (workerOnly.length || localOnly.length) {
    allOk = false;
    console.error('FAIL R4: 线上/本地单证类型不一致');
    if (workerOnly.length) console.error('  仅线上有（本地开不出）: ' + workerOnly.join(', '));
    if (localOnly.length) console.error('  仅本地有（线上会报 422）: ' + localOnly.join(', '));
  }
  if (workerNoPrefix.length) {
    allOk = false;
    console.error('FAIL R4: 线上编号前缀未覆盖: ' + workerNoPrefix.join(', '));
  }
  if (sharedNoFieldKeys.length === 0) {
    allOk = false;
    console.error('FAIL R4: 无法从 ' + SHARED_PAYLOAD + ' 解析 DOC_NO_FIELDS');
  }
  if (noFieldsMissing.length) {
    allOk = false;
    console.error(
      'FAIL R4: 单证类型缺单号字段映射（单号会静默退化）: ' + noFieldsMissing.join(', '),
    );
  }
  if (noFieldsShadowed.length) {
    allOk = false;
    console.error(
      'FAIL R4: 适配层重复定义 DOC_NO_FIELDS（应只 import 共享内核，禁止再抄一份）: ' +
        noFieldsShadowed.join(', '),
    );
  }
  if (
    !workerOnly.length &&
    !localOnly.length &&
    !workerNoPrefix.length &&
    sharedNoFieldKeys.length > 0 &&
    !noFieldsMissing.length &&
    !noFieldsShadowed.length
  ) {
    console.log(
      'PASS R4: worker mirror consistent (' +
        workerDocTypes.length +
        ' types, ' +
        sharedNoFieldKeys.length +
        ' no-field mappings from shared kernel, 0 shadow definitions)',
    );
  }
}

// ── R5: admin 端点响应键集合一致性（棘轮，双向生效）──────────────────────
// 登记文件缺席 = 所有偏差都算「未登记」⇒ 直接红，避免门禁被静默绕过。
const R5_ALLOWLIST = 'scripts/contracts-allowlist.txt';
const r5Registered = new Map<string, string>();
if (!existsSync(resolve(REPO_ROOT, R5_ALLOWLIST))) {
  allOk = false;
  console.error('FAIL R5: 缺棘轮登记文件 ' + R5_ALLOWLIST);
} else {
  for (const line of read(R5_ALLOWLIST).split('\n')) {
    const text = line.trim();
    if (text === '' || text.startsWith('#')) continue;
    const hash = text.indexOf('#');
    const key = (hash === -1 ? text : text.slice(0, hash)).trim().replace(/\s+/g, ' ');
    if (key === '') continue;
    r5Registered.set(key, hash === -1 ? '' : text.slice(hash + 1).trim());
  }
}

interface R5Deviation {
  key: string;
  details: string[];
}

const r5Deviations: R5Deviation[] = [];
let r5Checked = 0;

for (const rule of R5_RULES) {
  for (const source of rule.sources) {
    const label = rule.id + ' ' + source.side;
    const details: string[] = [];
    r5Checked++;
    if (!existsSync(resolve(REPO_ROOT, source.file))) {
      details.push('源文件不存在: ' + source.file);
    } else {
      const src = read(source.file);
      if (source.kind === 'handler') {
        const keys = pyHandlerKeys(src, source.method, source.route);
        if (keys.shape === 'missing') {
          details.push(
            '未解析到 ' +
              source.method.toUpperCase() +
              ' ' +
              source.route +
              ' 的 return 字面量',
          );
        } else if (rule.expectedGeneric) {
          // 期望「tenant_id → {flag: bool}」映射：字面量对象（flag_name/flag_value）即偏差
          if (keys.shape !== 'dynamic-map') {
            details.push(
              '期望 tenant→flags 映射，实际是字面量对象 [' +
                keys.envelope.join(', ') +
                ']',
            );
          }
        } else if (keys.shape === 'dynamic-map') {
          details.push('解析到动态字典推导，无法确定键集合');
        } else {
          if (!sameKeySet(keys.envelope, rule.expectedEnvelope)) {
            details.push(
              '包封键 期望[' +
                rule.expectedEnvelope.join(', ') +
                '] 实际[' +
                keys.envelope.join(', ') +
                ']',
            );
          }
          if (
            rule.expectedItem &&
            keys.item.length > 0 &&
            !sameKeySet(keys.item, rule.expectedItem)
          ) {
            details.push(
              '条目键 期望[' +
                rule.expectedItem.join(', ') +
                '] 实际[' +
                keys.item.join(', ') +
                ']',
            );
          }
        }
      } else if (source.kind === 'ts-interface') {
        const fields = tsInterfaceFields(src, source.iface);
        if (fields.length === 0) {
          details.push('未解析到 interface ' + source.iface + ' 的字段');
        } else if (rule.expectedGeneric) {
          details.push('该规则期望映射形状，不适用 interface 比对');
        } else {
          // 前端消费侧用**子集**语义：只要求「期望键都在」——
          // 多出的展示字段（如 types.ts 的 locale/region/product_categories）不是响应键偏差；
          // 少了 / 改名了（name vs display_name）才是。
          const want =
            source.compares === 'item'
              ? (rule.expectedItem ?? [])
              : rule.expectedEnvelope;
          const missing = want.filter((k) => !fields.includes(k));
          if (missing.length > 0) {
            details.push(
              '缺少期望' +
                (source.compares === 'item' ? '条目键' : '包封键') +
                ' [' +
                missing.join(', ') +
                ']（实际 [' +
                fields.join(', ') +
                ']）',
            );
          }
        }
      } else {
        const arg = tsGenericArg(src, source.call);
        if (arg === null) {
          details.push('未解析到 ' + source.call + '<T> 的泛型实参');
        } else if (arg !== rule.expectedGeneric) {
          details.push(
            '泛型实参 期望 "' +
              String(rule.expectedGeneric) +
              '" 实际 "' +
              arg +
              '"',
          );
        }
      }
    }
    if (details.length > 0) {
      r5Deviations.push({ key: label, details });
    }
  }
}

// R5 · 请求体形状（三方：前端调用点 / orchestrator / worker）
for (const rule of R5_BODY_RULES) {
  const frontendLabel = rule.id + ' ' + rule.frontend.side;
  let sent: string[] = [];
  if (!existsSync(resolve(REPO_ROOT, rule.frontend.file))) {
    r5Checked++;
    r5Deviations.push({
      key: frontendLabel,
      details: ['源文件不存在: ' + rule.frontend.file],
    });
  } else {
    r5Checked++;
    sent = tsObjectLiteralKeys(read(rule.frontend.file), rule.frontend.anchor);
    if (sent.length === 0) {
      r5Deviations.push({
        key: frontendLabel,
        details: [
          '未解析到 ' +
            rule.frontend.anchor +
            ' 之后的对象字面量键（' +
            rule.frontend.file +
            '）',
        ],
      });
    } else {
      const missing = rule.requiredKeys.filter((k) => !sent.includes(k));
      if (missing.length > 0) {
        r5Deviations.push({
          key: frontendLabel,
          details: [
            '调用点没发必需的键 [' +
              missing.join(', ') +
              ']（实际发送 [' +
              sent.join(', ') +
              ']）',
          ],
        });
      }
    }
  }

  for (const backend of rule.backends) {
    const label = rule.id + ' ' + backend.side;
    r5Checked++;
    if (!existsSync(resolve(REPO_ROOT, backend.file))) {
      r5Deviations.push({ key: label, details: ['源文件不存在: ' + backend.file] });
      continue;
    }
    const body = pyHandlerBody(read(backend.file), backend.method, backend.route);
    if (body === null) {
      r5Deviations.push({
        key: label,
        details: [
          '未解析到 ' +
            backend.method.toUpperCase() +
            ' ' +
            backend.route +
            ' 的 handler',
        ],
      });
      continue;
    }
    const reads = pyBodyReadKeys(body);
    const missing = rule.requiredKeys.filter((k) => !reads.includes(k));
    if (missing.length > 0) {
      // 这正是历史 422 的形状：后端不认前端发来的键
      r5Deviations.push({
        key: label,
        details: [
          '未读取前端发来的必需键 [' + missing.join(', ') + ']',
          '实际读取 [' + reads.join(', ') + ']',
          sent.length ? '前端发送 [' + sent.join(', ') + ']' : '前端调用点未解析到',
        ],
      });
    } else if (sent.length > 0) {
      const unread = sent.filter((k) => !reads.includes(k));
      if (unread.length > 0) {
        // 后端不校验多余键 ⇒ 前端多发不算偏差（如 worker 用登录用户 id 替代 actor_id）。
        // 只提示，不下结论说"这是审计字段"—— 键的性质只有人知道。
        console.log(
          'INFO R5.4: ' +
            backend.side +
            ' 未读取前端发来的键（后端不校验多余键，允许）: ' +
            unread.join(', '),
        );
      }
    }
  }
}

// ── R6 执行：openapi.json 新鲜度（两侧基准都取 HEAD 快照）────────────────
const r6Deviations: R5Deviation[] = [];
let r6Stats = { paths: 0, models: 0, responseModels: 0, outOfSchema: 0 };

try {
  const r6HeadShort = execFileSync(
    'git',
    ['-C', REPO_ROOT, 'rev-parse', '--short', 'HEAD'],
    { encoding: 'utf-8' },
  ).trim();
  const artifact = JSON.parse(
    readAtRev(R6_ARTIFACT.rev, R6_ARTIFACT.path),
  ) as R6Artifact;

  // 1) 解析 HEAD 源码：路由（path+method、response_model）与模型字段
  const routes = new Map<string, Set<string>>();
  const responseModels: Array<{ method: string; path: string; declared: string[] }> = [];
  const modelVariants = new Map<string, string[][]>();
  let outOfSchema = 0;
  for (const f of gitLsTreeAt(R6_BASELINE_REV, R6_APP_DIR)) {
    if (!f.endsWith('.py')) continue;
    const src = readAtRev(R6_BASELINE_REV, f);
    const prefix = pyRouterPrefix(src);
    for (const r of pyRoutes(src)) {
      // include_in_schema=False：FastAPI 注册但不进 OpenAPI —— 不能算 artifact 缺失
      if (/include_in_schema\s*=\s*False/.test(r.args)) {
        outOfSchema++;
        continue;
      }
      const full = prefix + r.path;
      let set = routes.get(full);
      if (!set) {
        set = new Set<string>();
        routes.set(full, set);
      }
      set.add(r.method);
      const rm = /response_model\s*=\s*([A-Za-z_][\w.\[\], ]*)/.exec(r.args);
      if (rm) {
        responseModels.push({
          method: r.method,
          path: full,
          declared: [...rm[1].matchAll(/\b([A-Z]\w+)\b/g)].map((x) => x[1]),
        });
      }
    }
    for (const [name, fields] of pyModelFields(src)) {
      const list = modelVariants.get(name) ?? [];
      list.push(fields);
      modelVariants.set(name, list);
    }
  }

  const artPaths = new Set(Object.keys(artifact.paths ?? {}));
  const parsedPaths = new Set([...routes.keys(), ...R6_NON_DECORATOR_PATHS]);
  const onlyArtifact = [...artPaths].filter((p) => !parsedPaths.has(p)).sort();
  const onlySource = [...parsedPaths].filter((p) => !artPaths.has(p)).sort();
  // 每条漂移**单独一个 key**（而不是 `R6 paths` 这种粗粒度 key）：
  // 粗 key 会让"登记了一条缺路径"把**之后所有**路径漂移都吞成 KNOWN ⇒ 棘轮失效。
  const baselineNote =
    '（源码基准 rev=' +
    r6HeadShort +
    '；产物基准 rev=' +
    (R6_ARTIFACT.rev === '' ? 'FILE:' + R6_ARTIFACT.path : R6_ARTIFACT.rev) +
    '；非装饰器例外: ' +
    R6_NON_DECORATOR_PATHS.join(', ') +
    '；include_in_schema=False 跳过 ' +
    outOfSchema +
    ' 条）';
  for (const p of onlySource) {
    r6Deviations.push({
      key: 'R6.path-missing:' + p,
      details: [
        'HEAD 源码有、artifact 未登记 ' + baselineNote,
        // 这一步最容易让人困惑：本地刚重生成过 openapi.json，这里却仍报缺失。
        // 原因：R6 两侧（源码与 artifact）都取 **HEAD 快照**，工作树里未提交的产物不算数。
        // 提示写在这里，避免后来者以为门禁坏了或自己改错了。
        '若你刚在本地重生成过 openapi.json：R6 两侧都取 HEAD 快照 ⇒ 需先**提交**产物才会变绿',
      ],
    });
  }
  for (const p of onlyArtifact) {
    r6Deviations.push({
      key: 'R6.path-extra:' + p,
      details: ['artifact 登记了 HEAD 源码解析不到的路径 ' + baselineNote],
    });
  }
  if (onlyArtifact.length > 0 || onlySource.length > 0) {
    console.log(
      'INFO R6: 路径漂移 源码有而 artifact 无 ' +
        onlySource.length +
        ' 条、artifact 有而源码无 ' +
        onlyArtifact.length +
        ' 条',
    );
  }

  // 2) 每个 path 的 HTTP 方法集合
  for (const p of artPaths) {
    const routeSet = routes.get(p);
    if (!routeSet) continue; // 例外路径（/metrics）没有源码装饰器
    const inArtifact = Object.keys(artifact.paths![p])
      .filter((k) => k !== 'parameters')
      .map((k) => k.toUpperCase())
      .sort();
    const inSource = [...routeSet].sort();
    if (inArtifact.join(',') !== inSource.join(',')) {
      r6Deviations.push({
        key: 'R6.methods:' + p,
        details: ['artifact=[' + inArtifact + '] src=[' + inSource + ']'],
      });
    }
  }

  // 3) response_model 引用
  for (const rm of responseModels) {
    const entry = artifact.paths?.[rm.path];
    if (!entry) continue; // 路径缺失已由 R6.1 报出
    const op = entry[rm.method.toLowerCase()] as
      | { responses?: Record<string, unknown> }
      | undefined;
    if (!op) continue;
    const success = Object.entries(op.responses ?? {}).find(([code]) =>
      /^2\d\d$/.test(code),
    );
    const refs = success
      ? [
          ...JSON.stringify(success[1]).matchAll(
            /"#\/components\/schemas\/(\w+)"/g,
          ),
        ].map((x) => x[1])
      : [];
    if (rm.declared.length > 0 && refs.length === 0) {
      r6Deviations.push({
        key: 'R6.response-model:' + rm.method + ' ' + rm.path,
        details: [
          '声明 response_model=' +
            rm.declared.join('|') +
            '，artifact 2xx 响应无 $ref',
        ],
      });
    } else if (refs.length > 0 && !refs.every((r) => rm.declared.includes(r))) {
      r6Deviations.push({
        key: 'R6.response-model:' + rm.method + ' ' + rm.path,
        details: [
          '声明 [' + rm.declared + '] 而 artifact 引用 [' + refs + ']',
        ],
      });
    }
  }

  // 4) 模型字段键集合（同名类多处定义 ⇒ 任一处一致即算一致）
  const schemas = artifact.components?.schemas ?? {};
  let compared = 0;
  for (const name of Object.keys(schemas)) {
    if (r6SkipSchema(name)) continue;
    const variants = modelVariants.get(name);
    if (!variants) continue; // 源码里没有同名类（内联/自动生成）⇒ 无可比
    compared++;
    if (variants.length > 1) {
      console.log(
        'INFO R6: 同名模型多处定义 ' +
          name +
          ' × ' +
          variants.length +
          '（任一处与 artifact 一致即通过）',
      );
    }
    const inArtifact = Object.keys(schemas[name].properties ?? {}).sort();
    const ok = variants.some(
      (v) => [...new Set(v)].sort().join(',') === inArtifact.join(','),
    );
    if (!ok) {
      r6Deviations.push({
        key: 'R6.schema:' + name,
        details: [
          '字段键集合不一致 artifact=[' +
            inArtifact +
            '] src=[' +
            variants.map((v) => [...new Set(v)].sort().join('|')).join(' / ') +
            ']',
        ],
      });
    }
  }

  r6Stats = {
    paths: artPaths.size,
    models: compared,
    responseModels: responseModels.length,
    outOfSchema,
  };
} catch (e) {
  r6Deviations.push({
    key: 'R6 baseline',
    details: [
      '无法从 ' +
        R6_ARTIFACT.rev +
        ' 快照读取基准（' +
        R6_ARTIFACT.path +
        '）: ' +
        String(e),
    ],
  });
}

const allDeviations = [...r5Deviations, ...r6Deviations];
const r5Found = new Set(allDeviations.map((d) => d.key));
const r5Unregistered = allDeviations.filter((d) => !r5Registered.has(d.key));
// 棘轮的另一半：登记了但**偏差已经不存在**（修好却忘删行）同样是失败。
const r5Overdue = [...r5Registered.keys()].filter((k) => !r5Found.has(k));

for (const d of allDeviations) {
  if (r5Registered.has(d.key)) {
    console.warn('KNOWN: ' + d.key + ' —— ' + (r5Registered.get(d.key) || '(未写原因)'));
  }
}

if (r5Unregistered.length > 0) {
  allOk = false;
  console.error('FAIL R5/R6: 契约比对出现**未登记**的偏差');
  // 每条漂移一个 key ⇒ 整片陈旧时会很多条：最多列 30 条，其余只报总数（不静默吞掉）
  for (const d of r5Unregistered.slice(0, 30)) {
    console.error('  ' + d.key);
    d.details.forEach((x) => console.error('    - ' + x));
  }
  if (r5Unregistered.length > 30) {
    console.error(
      '  …还有 ' +
        (r5Unregistered.length - 30) +
        ' 条未列出（未登记偏差共 ' +
        r5Unregistered.length +
        ' 条）',
    );
  }
  console.error('  => 有意变更契约：改 ' + R5_ALLOWLIST + ' 并写清「待哪个修复还掉」；');
  console.error('     期望形状过时：改 scripts/contracts-check.ts 的 R5_RULES / R6 配置。');
}

if (r5Overdue.length > 0) {
  allOk = false;
  console.error(
    'FAIL R5/R6: 棘轮登记已过期（偏差已修好，请删掉这些行）: ' + r5Overdue.join(', '),
  );
}

if (r5Unregistered.length === 0 && r5Overdue.length === 0) {
  console.log(
    'PASS R5: ' +
      R5_RULES.length +
      ' 响应端点 + ' +
      R5_BODY_RULES.length +
      ' 请求体规则，' +
      r5Checked +
      ' 侧比对通过（其中 ' +
      r5Deviations.length +
      ' 侧为已登记偏差，见 ' +
      R5_ALLOWLIST +
      '）',
  );
  console.log(
    'PASS R6: openapi.json 新鲜度（基准 rev=HEAD 快照）：' +
      r6Stats.paths +
      ' paths / ' +
      r6Stats.models +
      ' 模型字段键集合 / ' +
      r6Stats.responseModels +
      ' response_model 引用 一致' +
      '（include_in_schema=False 跳过 ' +
      r6Stats.outOfSchema +
      ' 条，非装饰器例外 ' +
      R6_NON_DECORATOR_PATHS.join(',') +
      '）',
  );
}

if (allOk) {
  process.exit(0);
} else {
  console.error('FAIL: one or more checks failed');
  process.exit(1);
}