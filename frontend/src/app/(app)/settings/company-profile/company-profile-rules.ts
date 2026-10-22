/**
 * 企业信息页的纯规则（无 React 依赖，可直接单测）。
 *
 * 单独成文件的原因：页面里混着 useQuery / toast / 公章卡片，
 * 「税号怎么归一化、保存 payload 长什么样、公章谁能写」这些判定要能被测试
 * 直接钉住，而不是靠渲染整页（会牵连并行改动中的条款模板卡片）。
 */
import type { CompanyProfile } from "../../trade-docs/hooks/use-trade-docs";

/** 公司税号（统一社会信用代码/纳税人识别号）：6–32 位大写字母或数字 */
export const TAX_ID_PATTERN = /^[0-9A-Z]{6,32}$/;

/** 税号归一化：去空格 + 大写（用户常粘贴带空格/小写的统一社会信用代码） */
export function normalizeTaxId(raw: string | null | undefined): string {
  return (raw ?? "").trim().toUpperCase();
}

/** SWIFT 归一化：去空格 + 大写 */
export function normalizeSwiftCode(raw: string | null | undefined): string {
  return (raw ?? "").trim().toUpperCase();
}

export type CompanyProfileSaveResult =
  | { ok: true; payload: Partial<CompanyProfile> & { name_en: string } }
  | { ok: false; error: string };

/**
 * 把表单草稿变成 PUT /tenant/company-profile 的 payload。
 *
 * 口径（与后端一致）：
 *   · 公司英文名必填（它是单据上的卖方主体名）；
 *   · SWIFT 允许空；非空必须是 8 位或 11 位字母数字；
 *   · 公司税号允许空；非空必须是 6–32 位大写字母/数字（先 trim + 大写再校验）；
 *   · 空串统一转 null —— 「清空字段」在语义上等于「没有」，避免单据印出一行空白。
 */
export function buildCompanyProfileSavePayload(
  draft: Record<string, string>,
): CompanyProfileSaveResult {
  const nameEn = (draft.name_en ?? "").trim();
  if (!nameEn) {
    return { ok: false, error: "公司英文名必填 —— 它是单据上的卖方主体名" };
  }

  const swiftCode = normalizeSwiftCode(draft.swift_code);
  if (swiftCode && !/^[A-Z0-9]{8}([A-Z0-9]{3})?$/.test(swiftCode)) {
    return {
      ok: false,
      error: "SWIFT Code 必须是 8 位或 11 位字母/数字（如 BKCHCNBJ220）",
    };
  }

  const taxId = normalizeTaxId(draft.tax_id);
  if (taxId && !TAX_ID_PATTERN.test(taxId)) {
    return {
      ok: false,
      error: "公司税号只能是 6–32 位大写字母或数字（如 91131125MA0GA4242U）",
    };
  }

  return {
    ok: true,
    payload: {
      ...(draft as Partial<CompanyProfile>),
      name_en: nameEn,
      swift_code: swiftCode || null,
      tax_id: taxId || null,
    },
  };
}

/**
 * 公章写入权限。
 *
 * 历史 bug：这里曾经用 `user.account_type === 'internal'` 判定 ⇒
 * **团队管理员（客户账号）永远看不到上传/设默认/删除入口**，
 * 而成员反而能操作。
 * 现口径与后端写闸门一致：`canEdit`（= `useTeam().isTeamAdmin`，
 * 与 `main.py` 的 `_require_team_admin` 同判据）—— 管理员可写、成员只读。
 */
export function canManageCompanySeals(isTeamAdmin: boolean): boolean {
  return isTeamAdmin;
}
