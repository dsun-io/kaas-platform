import { readFileSync, existsSync } from 'fs';
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

if (allOk) {
  process.exit(0);
} else {
  console.error('FAIL: one or more checks failed');
  process.exit(1);
}