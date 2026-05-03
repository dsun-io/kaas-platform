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
  'chat.turn',
  'kb.edit',
  'quote.request',
  'quote.response',
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
  process.exit(0);
} else {
  console.error('FAIL: one or more checks failed');
  process.exit(1);
}
