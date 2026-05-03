/**
 * contracts-check.ts — 三方比对校验
 *
 * 校验 shared/contracts/events.ts 的 event_type 字面量是否与以下两处一致:
 * 1. shared/contracts/events.registry.md (markdown 表格)
 * 2. backend/orchestrator/app/domain/schema_registry.py (PAYLOAD_SCHEMAS keys)
 *
 * 也校验 shared/contracts/quote.ts 与 backend schemas 的字段一致性。
 *
 * 任何不一致 exit 1 + 打印 diff。
 */
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// When run via `pnpm contracts:check` from frontend/, cwd = frontend/
const REPO_ROOT = resolve(process.cwd(), '..');

function read(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf-8');
}

// ── R0: Event type consistency ─────────────────────────────────────────────

const KNOWN_EVENTS = [
  'audit.access',
  'capability.update',
  'chat.turn',
  'kb.edit',
  'quote.request',
  'quote.response',
] as const;

function extractFromTs(): string[] {
  const content = read('shared/contracts/events.ts');
  const matches: string[] = [];
  for (const ev of KNOWN_EVENTS) {
    if (content.includes(`'${ev}'`)) matches.push(ev);
  }
  return matches.sort();
}

function extractFromMd(): string[] {
  const content = read('shared/contracts/events.registry.md');
  const regex = /^##\s+(.+?)\s+\(v1\)/gm;
  const matches = [...content.matchAll(regex)].map((m) => m[1].trim()).sort();
  return matches;
}

function extractFromPy(): string[] {
  const bePath = resolve(REPO_ROOT, 'backend/orchestrator/app/domain/schema_registry.py');
  if (!existsSync(bePath)) {
    console.warn('⚠️  backend/orchestrator/app/domain/schema_registry.py 尚未创建，跳过校验');
    process.exit(0);
  }
  const content = readFileSync(bePath, 'utf-8');
  const regex = /"([a-z]+\.[a-z_]+)"/g;
  const matches = [...content.matchAll(regex)].map((m) => m[1]).sort();
  return matches;
}

// ── R1: Quote contract field consistency ───────────────────────────────────

/** Extract { className → field names[] } from quote_v2.py (Pydantic) */
function extractQuotePyFields(): Map<string, string[]> {
  const content = read('backend/orchestrator/app/schemas/quote_v2.py');
  const result = new Map<string, string[]>();
  const classRe = /^class (\w+)\(BaseModel\):/gm;
  let match: RegExpExecArray | null;
  while ((match = classRe.exec(content)) !== null) {
    const className = match[1];
    const fields: string[] = [];
    // From class start to next class or EOF
    const classStart = match.index;
    const nextClass = content.slice(classStart + 1).search(/\nclass \w+\(/);
    const classEnd = nextClass === -1 ? content.length : classStart + 1 + nextClass;
    const classBody = content.slice(classStart, classEnd);
    const fieldRe = /^\s+(\w+)\s*:/gm;
    let fm: RegExpExecArray | null;
    while ((fm = fieldRe.exec(classBody)) !== null) {
      fields.push(fm[1]);
    }
    if (fields.length > 0) result.set(className, fields.sort());
  }
  return result;
}

/** Extract { schemaName → field names[] } from quote.ts (Zod) */
function extractQuoteTsFields(): Map<string, string[]> {
  const content = read('shared/contracts/quote.ts');
  const result = new Map<string, string[]>();
  const schemaRe = /^export const (\w+)Schema\s*=\s*z\.object\(\{/gm;
  let match: RegExpExecArray | null;
  while ((match = schemaRe.exec(content)) !== null) {
    const name = match[1];
    const fields: string[] = [];
    const bodyStart = match.index + match[0].length; // right after the opening `{`
    let braceDepth = 1; // we've already seen the opening `{`
    let closeIdx = -1;
    for (let i = bodyStart; i < content.length; i++) {
      if (content[i] === '{') braceDepth++;
      else if (content[i] === '}') {
        braceDepth--;
        if (braceDepth === 0) { closeIdx = i; break; }
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
    if (fields.length > 0) result.set(name, fields.sort());
  }
  return result;
}

/** Map Zod schema names → Pydantic class names */
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

// ── Main ───────────────────────────────────────────────────────────────────

let allOk = true;

// R0 check
const ts = extractFromTs();
const md = extractFromMd();
const py = extractFromPy();

const tsJson = JSON.stringify(ts);
const mdJson = JSON.stringify(md);
const pyJson = JSON.stringify(py);

if (tsJson !== mdJson || mdJson !== pyJson) {
  allOk = false;
  console.error('❌ R0 一致性校验失败 — event_type 三方不一致');
  if (tsJson !== mdJson) {
    console.error(`\n  events.ts (${ts.length}):              ${ts.join(', ')}`);
    console.error(`  events.registry.md (${md.length}):       ${md.join(', ')}`);
    console.error('  → events.ts 与 events.registry.md 不匹配');
  }
  if (mdJson !== pyJson) {
    console.error(`\n  events.registry.md (${md.length}):       ${md.join(', ')}`);
    console.error(`  schema_registry.py (${py.length}):        ${py.join(', ')}`);
    console.error('  → events.registry.md 与 schema_registry.py 不匹配');
  }
} else {
  console.log(`✅ R0 event_type 一致 — ${ts.length} 个, 3 来源一致`);
  console.log(`   ${ts.join(', ')}`);
}

// R1 check
const tsFields = extractQuoteTsFields();
const pyFields = extractQuotePyFields();

for (const [zodName, pyName] of Object.entries(ZOD_TO_PY)) {
  const tsF = tsFields.get(zodName);
  const pyF = pyFields.get(pyName);
  if (!tsF) {
    allOk = false;
    console.error(`❌ R1 quote.ts 缺少 ${zodName}Schema`);
    continue;
  }
  if (!pyF) {
    allOk = false;
    console.error(`❌ R1 quote_v2.py 缺少 ${pyName} class`);
    continue;
  }
  const tsSet = new Set(tsF);
  const pySet = new Set(pyF);
  const onlyTs = tsF.filter((f) => !pySet.has(f));
  const onlyPy = pyF.filter((f) => !tsSet.has(f));
  if (onlyTs.length > 0 || onlyPy.length > 0) {
    allOk = false;
    console.error(`❌ R1 字段不一致 — ${zodName}`);
    if (onlyTs.length) console.error(`   quote.ts 独有: ${onlyTs.join(', ')}`);
    if (onlyPy.length) console.error(`   quote_v2.py 独有: ${onlyPy.join(', ')}`);
  }
}

if (allOk) {
  console.log(`✅ R1 quote 合约字段一致 — ${Object.keys(ZOD_TO_PY).length} 个 schema/pydantic 匹配`);
  process.exit(0);
} else {
  process.exit(1);
}
