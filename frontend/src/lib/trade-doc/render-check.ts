/**
 * 「定时对账」结论 → 单证列表的一眼标识（TODO(TODO:A8/A9)）
 *
 * 背景：签发时冻结了渲染输入指纹；每日 cron 重装配一遍做对账，结论写进
 * `trade_doc_render_checks`，列表端点把最近一次结论挂在每行 `render_check` 上。
 * 本模块只做**展示映射**（判定全在共享内核），三条口径要守住：
 *
 * 1. **从未对账 ⇒ 不显示任何标识**（`null`）：不能把"没查过"画成"没问题"，
 *    也不能画成"已变更"—— 两种都是假结论；
 * 2. **一致是常态 ⇒ 不显示**：每行都挂个绿标等于噪音，反而让异常看不见；
 * 3. **版本漂移与数据被改分开**：前者是模板/渲染器升级（内容没变，通常无需动作），
 *    后者是签发后数据被改（ юридично 敏感，要红）。
 */

export interface RenderCheckSummary {
  matches: boolean;
  /** 共享内核 reason 原值：matched / data_changed / version_drift /
   *  no_fingerprint / current_unavailable / frozen_unavailable */
  reason: string;
  render_version_drift: boolean;
  checked_at: string | null;
}

export interface RenderCheckBadge {
  label: string;
  tone: "default" | "success" | "warning" | "danger" | "info";
  title: string;
}

function when(checkedAt: string | null): string {
  return checkedAt ? `对账时间 ${checkedAt}` : "尚未记录对账时间";
}

/** 无标识（null）= 不打扰：未对账 / 一致 / 无基线 三种情况都不需要眼睛去处理。
 *
 * 注意：`no_fingerprint` 是"草稿/老单据没有基线"，属于**正常**状态，
 * 不要为了"看起来更完整"给它加个灰标 —— 列表里每行都有标等于没有标。
 */
export function renderCheckBadge(
  check?: RenderCheckSummary | null,
): RenderCheckBadge | null {
  if (!check) return null;
  if (check.matches) return null;
  if (check.reason === "no_fingerprint") return null;

  switch (check.reason) {
    case "data_changed":
      return {
        label: "已变更",
        tone: "danger",
        title: `签发后单证数据被修改（${when(check.checked_at)}）`,
      };
    case "version_drift":
      return {
        label: "模板已更新",
        tone: "warning",
        title: `内容摘要一致，但模板/渲染器版本与签发时不同（${when(check.checked_at)}）`,
      };
    case "current_unavailable":
    case "frozen_unavailable":
      return {
        label: "待复核",
        tone: "warning",
        title: `对账时装配失败，无法判定是否一致（${when(check.checked_at)}）`,
      };
    default:
      return {
        label: "待复核",
        tone: "warning",
        title: `对账结论：${check.reason}（${when(check.checked_at)}）`,
      };
  }
}
