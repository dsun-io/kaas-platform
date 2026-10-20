import apiClient from "@/lib/api/client";
import { renderTradeDoc } from "@/lib/trade-doc/render";

export interface AutoArchiveResult {
  ok: boolean;
  /** 失败原因（直接给用户看的中文）；成功时为上传字节数说明 */
  message: string;
}

/**
 * 签发后自动出 PDF 并上传（业务口径叫“上传单证”，不叫“归档”）。
 *
 * 为什么不是后端直接做：HTML 模板在前端（`lib/trade-doc/render`），服务端只提供
 * `POST /trade-docs/{id}/pdf`（接收 HTML → Browser Rendering 出字节 → 存档）。
 * 因此 Web UI 在“签发成功”后立刻把当前渲染结果送过去，客户不再需要手动导出/导入。
 *
 * 手动上传入口（`files/upload`）**保留**：渲染器不可用、第三方单据、历史补档等特殊情况仍可人工上传。
 */
export async function autoArchiveIssuedDoc(
  docId: number,
): Promise<AutoArchiveResult> {
  try {
    const { data } = await apiClient.get<{
      doc: { doc_type: string };
      data: Record<string, unknown>;
    }>(`/trade-docs/${docId}/render-data`);

    const html = renderTradeDoc(data.doc.doc_type, data.data);
    const res = await apiClient.post<{ bytes?: number; renderer?: string }>(
      `/trade-docs/${docId}/pdf`,
      { html },
    );
    const kb = res.data?.bytes
      ? Math.max(1, Math.round(res.data.bytes / 1024))
      : null;
    return {
      ok: true,
      message: kb ? `已自动上传单证（${kb} KB）` : "已自动上传单证",
    };
  } catch (error) {
    const status = (error as { response?: { status?: number } }).response
      ?.status;
    if (status === 503) {
      return {
        ok: false,
        message: "服务端未配置 PDF 渲染器，请先手动上传",
      };
    }
    if (status === 422) {
      return {
        ok: false,
        message: "单据 HTML 未通过服务端校验，请手动上传",
      };
    }
    return {
      ok: false,
      message: "自动上传失败，请稍后重试或手动上传",
    };
  }
}
