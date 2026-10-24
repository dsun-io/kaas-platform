/**
 * 产品英文名（一名多写法 / 主名）—— 前端只做**展示与搬运**。
 *
 * 权威口径在 Python 内核：`backend/kaas_common/export_quote/product_names.py`
 * （同一份规则被 `sync-shared.ps1` 镜像进 Worker）。这里保留一份**最小镜像**，
 * 只服务两件事：
 *   1. 产品卡/详情页把 `/products`、`/products/{key}/profile` 里的英文名读成
 *      「主名 + 地区别名」的稳定形状（列表/主名判断不能各写各的）；
 *   2. 保存时把编辑器的多行输入整理成 `name_en_list` / `name_en_primary` 送后端
 *      —— 只是搬运，最终落库值由内核再归一化一次（前端判错也不会写脏数据）。
 *
 * 存储形状（`product_profiles.info`，团队作用域）：
 * - `name_en_list`    : string[]，**主名在前**
 * - `name_en_primary` : string，主英文名（= 列表第一个）
 * - `name_en`         : 历史单值（老前端/手工 SQL）；读侧当"唯一英文名"，不能当没配
 */

export const NAME_EN_LIST_KEY = "name_en_list";
export const NAME_EN_PRIMARY_KEY = "name_en_primary";
export const NAME_EN_LEGACY_KEY = "name_en";

function cleanName(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function asInfo(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

/** 单个输入框/接口值 → 英文名列表（去空白、丢空串、大小写不敏感去重、保留首次写法）。 */
export function normalizeNameEnList(value: unknown): string[] {
  const raw = typeof value === "string" ? [value] : value;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const name = cleanName(item);
    if (!name) continue;
    const folded = name.toLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    out.push(name);
  }
  return out;
}

/** 读：全部英文名（主名在前；兼容历史单值 `name_en`）。 */
export function nameEnListFromInfo(info: unknown): string[] {
  const data = asInfo(info);
  let names = normalizeNameEnList(data[NAME_EN_LIST_KEY]);
  if (names.length === 0) {
    const legacy = cleanName(data[NAME_EN_LEGACY_KEY]);
    if (legacy) names = [legacy];
  }
  const primary = cleanName(data[NAME_EN_PRIMARY_KEY]);
  if (primary) {
    const matched = names.find(
      (n) => n.toLowerCase() === primary.toLowerCase(),
    );
    const rest = matched ? names.filter((n) => n !== matched) : names;
    names = matched ? [matched, ...rest] : [primary, ...rest];
  }
  return names;
}

/** 读：主英文名；没配 → `""`（调用方回落注册表 `name_en`）。 */
export function primaryNameEnFromInfo(info: unknown): string {
  return nameEnListFromInfo(info)[0] ?? "";
}

export function hasNameEnInfo(info: unknown): boolean {
  const data = asInfo(info);
  if (NAME_EN_LIST_KEY in data || NAME_EN_PRIMARY_KEY in data) return true;
  return Boolean(cleanName(data[NAME_EN_LEGACY_KEY]));
}

/**
 * 写：把编辑器状态并进现有 `info`，返回完整对象送 `PUT /products/{key}/profile`。
 *
 * - `names` 不传 ⇒ 沿用 `info` 里现有的英文名（含历史单值）；
 * - `primary` 不传 ⇒ 沿用 `info.name_en_primary`；主名永远落成 `list[0]`；
 * - 其它键（用途/产地/材质选项/未知键）原样保留。
 *
 * 完全没配英文名、也不是显式来改英文名的请求 ⇒ **一个键都不加**（老前端只发
 * usage/origin/material_options 时，响应形状必须逐字不变）。
 */
export function applyNameEnInfo(
  info: unknown,
  names?: unknown,
  primary?: unknown,
): Record<string, unknown> {
  const data = asInfo(info);
  const explicit = names !== undefined || primary !== undefined;
  const hadKeys =
    NAME_EN_LIST_KEY in data ||
    NAME_EN_PRIMARY_KEY in data ||
    NAME_EN_LEGACY_KEY in data;

  let current =
    names === undefined
      ? [
          ...nameEnListFromInfo(data),
          ...(primary !== undefined ? normalizeNameEnList(primary) : []),
        ]
      : normalizeNameEnList(names);

  const wanted =
    primary !== undefined
      ? cleanName(primary)
      : cleanName(data[NAME_EN_PRIMARY_KEY]);
  if (wanted && current.length > 0) {
    const matched = current.find(
      (n) => n.toLowerCase() === wanted.toLowerCase(),
    );
    if (matched) {
      current = [matched, ...current.filter((n) => n !== matched)];
    }
  }

  if (!current.length && !explicit && !hadKeys) return data;

  data[NAME_EN_LIST_KEY] = current;
  data[NAME_EN_PRIMARY_KEY] = current[0] ?? "";
  if (NAME_EN_LEGACY_KEY in data) {
    data[NAME_EN_LEGACY_KEY] = current[0] ?? "";
  }
  return data;
}

/** 读端点用：有英文名时补出规范形状；完全没配 ⇒ 原样返回（不凭空加键）。 */
export function normalizedInfo(info: unknown): Record<string, unknown> {
  const data = asInfo(info);
  if (!hasNameEnInfo(data)) return data;
  return applyNameEnInfo(data);
}
