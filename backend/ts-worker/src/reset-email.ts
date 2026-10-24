/**
 * 重置密码邮件（**逐字直译** self backend/worker/src/main.py:576-675）：
 * - `resetEmailText`  ← main.py:576-584 `_reset_email_text`
 * - `resetEmailHtml`  ← main.py:587-651 `_reset_email_html`
 * - `sendResetEmail`  ← main.py:654-675 `_send_reset_email`
 *
 * 为什么放门面：P1 起 forgot-password 由门面直连 DB 落 token（不再经 Python 内核），
 * 发信必须同处完成，否则「重置链接已发送」是假话（历史 TODO:TS2 缺口）。
 * Resend REST 的本仓库既有调法见 routes/outreach.ts（同一端点、同一 Authorization 形态）。
 *
 * 边界（ADR-008）：只有「取绑定值 → HTTP POST」协议动作；邮件文案是既有 Python 文案的
 * 逐字搬运（P3 删除内核 auth 后本文件即唯一真源）。
 * 失败语义与 Python 一致：**发信失败只记日志、绝不抛**（响应形状不受影响）。
 */
import type { Env } from "./env";

/** Resend 发信端点（chain.py:49 / outreach.ts:42 同一常量）。 */
export const RESEND_API_URL = "https://api.resend.com/emails";

/** 重置 token 有效期（main.py:_RESET_TTL_MINUTES）。 */
export const RESET_TTL_MINUTES = 30;

/** 发件人兜底（main.py:659：`RESET_FROM_EMAIL` 未配时用它）。 */
export const DEFAULT_RESET_FROM_EMAIL = "noreply@send.powervoy.com";

/** 邮件主题（main.py:667）。 */
export const RESET_EMAIL_SUBJECT = "重置你的登录密码";

/** 纯文本兜底（main.py:576-584 `_reset_email_text`）。 */
export function resetEmailText(resetLink: string): string {
  return (
    "重置你的登录密码\n\n"
    + "我们收到了重置 KaaS 账号密码的请求。\n"
    + "请打开以下链接设置新密码（" + String(RESET_TTL_MINUTES) + " 分钟内有效，仅可使用一次）：\n\n"
    + resetLink + "\n\n"
    + "如果不是你本人操作，请忽略此邮件，你的密码不会被更改。\n\n"
    + "—— KaaS 平台 · 外贸单证与报价工作台"
  );
}

/**
 * HTML 正文（main.py:587-651 `_reset_email_html` 逐字搬运）：
 * electric blue 品牌色、12px 圆角、响应式 table 布局、不引外部图片/字体。
 */
export function resetEmailHtml(resetLink: string): string {
  const primary = "#2563EB";
  const primaryDark = "#1D4ED8";
  const ink = "#0F172A";
  const muted = "#64748B";
  const line = "#E2E8F0";
  const bg = "#F5F7FB";
  const year = "2026";
  return (
    "<!DOCTYPE html>"
    + "<html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
    + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    + "<meta name=\"color-scheme\" content=\"light\">"
    + "<title>重置你的登录密码 · KaaS</title></head>"
    + "<body style=\"margin:0;padding:0;background:" + bg + ";\">"
    + "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" "
    + "style=\"background:" + bg + ";padding:32px 16px;\"><tr><td align=\"center\">"
    + "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" "
    + "style=\"max-width:560px;background:#FFFFFF;border:1px solid " + line + ";"
    + "border-radius:12px;box-shadow:0 12px 30px -12px rgba(37,99,235,0.25);\">"
    // 品牌头部
    + "<tr><td style=\"padding:24px 28px 0;\">"
    + "<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\"><tr>"
    + "<td style=\"width:40px;height:40px;border-radius:10px;"
    + "background:linear-gradient(135deg,#3B82F6,#4F46E5);color:#FFFFFF;"
    + "font:700 20px/40px -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;"
    + "text-align:center;\">K</td>"
    + "<td style=\"padding-left:12px;font:600 18px/1.2 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:" + ink + ";\">KaaS"
    + "<div style=\"font:400 12px/1.6 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:" + muted + ";\">"
    + "外贸单证与报价工作台</div></td></tr></table></td></tr>"
    // 正文
    + "<tr><td style=\"padding:20px 28px 0;\">"
    + "<h1 style=\"margin:0 0 8px;font:700 22px/1.35 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:" + ink + ";\">"
    + "重置你的登录密码</h1>"
    + "<p style=\"margin:0;font:400 14px/1.7 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:" + muted + ";\">"
    + "我们收到了重置 KaaS 账号密码的请求。点击下面的按钮设置新密码即可继续使用平台。</p>"
    + "</td></tr>"
    // 按钮
    + "<tr><td style=\"padding:24px 28px 0;\">"
    + "<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\"><tr>"
    + "<td style=\"border-radius:10px;background:" + primary + ";\">"
    + "<a href=\"" + resetLink + "\" style=\"display:inline-block;padding:12px 28px;"
    + "font:600 14px/1.2 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;"
    + "color:#FFFFFF;text-decoration:none;border-radius:10px;\">设置新密码</a></td>"
    + "</tr></table>"
    + "<p style=\"margin:14px 0 0;font:400 12px/1.6 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:" + muted + ";\">"
    + "该链接 <strong style=\"color:" + ink + ";\">" + String(RESET_TTL_MINUTES) + "</strong> 分钟内有效，且只能使用一次。</p>"
    + "</td></tr>"
    // 兜底链接
    + "<tr><td style=\"padding:20px 28px 0;\">"
    + "<div style=\"border-top:1px solid " + line + ";padding-top:16px;font:400 12px/1.6 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:" + muted + ";\">"
    + "如果按钮无法点击，请复制以下链接到浏览器打开：<br>"
    + "<span style=\"word-break:break-all;color:" + primaryDark + ";\">" + resetLink + "</span></div>"
    + "</td></tr>"
    // 安全提示 + 页脚
    + "<tr><td style=\"padding:20px 28px 24px;\">"
    + "<div style=\"background:#F1F5F9;border-radius:10px;padding:12px 14px;font:400 12px/1.6 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:" + muted + ";\">"
    + "安全提示：KaaS 工作人员不会向你索要密码或重置链接；若不是你本人操作，请忽略此邮件，密码不会被更改。</div>"
    + "</td></tr>"
    + "<tr><td style=\"padding:16px 28px;border-top:1px solid " + line + ";font:400 12px/1.6 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:" + muted + ";background:#FAFBFC;border-radius:0 0 12px 12px;\">"
    + "KaaS 平台 · 外贸单证与报价工作台<br>© " + year + " KaaS</td></tr>"
    + "</table></td></tr></table></body></html>"
  );
}

/**
 * 经 Resend 发重置邮件（main.py:654-675 `_send_reset_email`）。
 * - `RESEND_API_KEY` 缺失 ⇒ 直接返回 false（Python 同口径：不抛、不影响响应）；
 * - 发件人 = `RESET_FROM_EMAIL` 或 `noreply@send.powervoy.com`；
 * - 任何异常只 console.error，返回 false（**绝不把发信失败变成 500**）；
 * - 超时 30s：与 Python `_http_post_json(timeout=30)` 同口径，避免出站请求拖死 isolate。
 */
export async function sendResetEmail(
  env: Env,
  toEmail: string,
  resetLink: string,
): Promise<boolean> {
  const apiKey = typeof env.RESEND_API_KEY === "string" ? env.RESEND_API_KEY : "";
  if (!apiKey) return false;
  const fromEmail =
    (typeof env.RESET_FROM_EMAIL === "string" && env.RESET_FROM_EMAIL) || DEFAULT_RESET_FROM_EMAIL;
  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail],
        subject: RESET_EMAIL_SUBJECT,
        html: resetEmailHtml(resetLink),
        text: resetEmailText(resetLink),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    return res.status === 200 || res.status === 201;
  } catch (e) {
    console.error("[auth] password reset email send failed", e);
    return false;
  }
}
