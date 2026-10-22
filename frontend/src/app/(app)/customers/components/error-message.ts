/**
 * 客户页统一的 API 错误 → 人话（原 page.tsx 内联 errMsg 移出）：
 * 询盘多产品弹窗（inquiry-form.tsx）也开始用，放独立文件避免两份口径漂移。
 *
 * 口径：后端 detail 可能是字符串（FastAPI HTTPException），也可能是对象
 * （{code, detail, message}）——对象优先读 detail/message，最后才露 code。
 */
export function errMsg(e: unknown): string {
  const err = e as {
    response?: { data?: { detail?: unknown; message?: string; code?: string } };
    message?: string;
  };
  const detail = err?.response?.data?.detail;
  if (typeof detail === "string" && detail) return detail;
  if (detail && typeof detail === "object") {
    // 后端部分错误把可读说明放在对象型 detail 里（如 {code, detail, open_orders}）
    const obj = detail as { detail?: string; message?: string; code?: string };
    return obj.detail || obj.message || obj.code || "请求失败";
  }
  return err?.response?.data?.message ?? err?.message ?? "请求失败";
}
