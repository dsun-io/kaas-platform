/**
 * contracts-check.ts — 三方比对校验
 *
 * 校验 shared/contracts/events.ts 的 event_type 字面量是否与以下两处一致:
 * 1. shared/contracts/events.registry.md (markdown 表格)
 * 2. backend/orchestrator/app/domain/schema_registry.py (PAYLOAD_SCHEMAS keys)
 *
 * 任何不一致 exit 1 + 打印 diff。
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

// When run via `pnpm contracts:check` from frontend/, cwd = frontend/
const REPO_ROOT = resolve(process.cwd(), '..');

function read(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf-8');
}

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
  const content = read('backend/orchestrator/app/domain/schema_registry.py');
  const regex = /"([a-z]+\.[a-z_]+)"/g;
  const matches = [...content.matchAll(regex)].map((m) => m[1]).sort();
  return matches;
}

const ts = extractFromTs();
const md = extractFromMd();
const py = extractFromPy();

const tsJson = JSON.stringify(ts);
const mdJson = JSON.stringify(md);
const pyJson = JSON.stringify(py);

const ok = tsJson === mdJson && mdJson === pyJson;

if (!ok) {
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
  process.exit(1);
}

console.log(`✅ R0 一致性通过 — 3 个来源一致, ${ts.length} 个 event_type:`);
console.log(`   ${ts.join(', ')}`);
