"use client";

/**
 * 产品管理数据层（产品图 / 基础信息）
 *
 * 放在 `lib/` 而不是 `app/(app)/products/`：**单证工位也要用**
 * （填单据内容时"从产品图库选图"），跨路由目录互相 import 很脏。
 *
 * 口径（与后端 `app/api/files.py` 契约一致）：
 * - 产品本体来自**代码里的 ProductSpec**（勾花网/牛栏网/鹿网），这里只维护
 *   **租户可编辑**的补充信息（`product_profiles.info`）与图片。
 * - 产品图**并存**：一个产品可以有多张生产图/尺寸图，用 `media_kind` 区分，用 `name` 命名。
 * - 产品图**可排序**：`sort_order` 是产品图库自己的位次（主图恒排最前），
 *   一次维护、所有引用它的单证同步生效 —— 所以顺序存在文件元数据上，
 *   与单证自己的 `trade_doc_files.sort_order` 分开（同一张图在不同单证可排不同位次）。
 * - 单证**引用**这些图（`trade_doc_files.file_id`）⇒ 一次维护、重复使用。
 *
 * 为什么图片要经过 blob：`/file-objects/{id}/content` 需要 Bearer 鉴权，
 * `<img src>` 带不上头，所以统一用 axios 取 blob 再 `URL.createObjectURL`。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";
import {
  xhrPostForm,
  xhrSend,
  type UploadProgressHandler,
} from "@/lib/api/xhr-upload";

export interface ProductMedia {
  id: number;
  name: string;
  media_kind: string | null;
  kind: string;
  storage: string;
  object_key: string | null;
  content_type: string | null;
  file_size: number | null;
  is_primary: boolean;
  sort_order: number;
  version: number;
  created_at: string | null;
}

export interface ProductRow {
  product_key: string;
  name: string;
  /** 默认英文名（团队资料主名优先；报价/单证用） */
  name_en?: string;
  /** 其它英文名（不含 name_en）—— 询盘产品输入等匹配也要认 */
  name_en_aliases?: string[];
  /** 全部英文名（默认名在前；编辑框/匹配的唯一回填源） */
  name_en_list?: string[];
  category_code?: string;
  media_count: number;
  profile: Record<string, unknown>;
}

export const productKeys = {
  all: ["products"] as const,
  list: ["products", "list"] as const,
  profile: (key: string) => ["products", "profile", key] as const,
  media: (key: string) => ["products", "media", key] as const,
  fileUrl: (id: number) => ["file-url", id] as const,
};

export function useProducts() {
  return useQuery({
    queryKey: productKeys.list,
    queryFn: async () => {
      const { data } = await apiClient.get<{
        items: ProductRow[];
        media_kinds: Record<string, string>;
      }>("/products");
      return data;
    },
  });
}

export function useProductProfile(productKey: string | null) {
  return useQuery({
    queryKey: productKeys.profile(productKey ?? ""),
    enabled: Boolean(productKey),
    queryFn: async () => {
      const { data } = await apiClient.get<{
        product_key: string;
        info: Record<string, unknown>;
      }>(`/products/${productKey}/profile`);
      return data;
    },
  });
}

export function useSaveProductProfile(productKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (info: Record<string, unknown>) => {
      const { data } = await apiClient.put(`/products/${productKey}/profile`, {
        info,
      });
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: productKeys.all });
    },
  });
}

export function useProductMedia(productKey: string | null) {
  return useQuery({
    queryKey: productKeys.media(productKey ?? ""),
    enabled: Boolean(productKey),
    queryFn: async () => {
      const { data } = await apiClient.get<{
        items: ProductMedia[];
        media_kinds: Record<string, string>;
      }>(`/products/${productKey}/media`);
      return data;
    },
  });
}

/**
 * 文件 sha256（十六进制）—— 直传必须先算好，服务端据此定 object_key 并去重。
 *
 * 返回 null = 当前环境算不了哈希：**非安全上下文**（HTTP 明文页面）与 jsdom 里
 * `crypto.subtle` 为 undefined（Frontend CI 实测红过）⇒ 调用方必须跳过直传，
 * 走服务端代传（multipart 由服务端自己算哈希，files.py 里 hashlib.sha256）。
 */
async function sha256Hex(file: File): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const digest = await subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 出错原因归一成人能读的短句（axios 错误优先给 HTTP 状态码） */
function describeUploadError(err: unknown): string {
  const status = (err as { response?: { status?: number } } | null)?.response
    ?.status;
  const message = err instanceof Error ? err.message : String(err);
  return status ? `HTTP ${status}（${message}）` : message;
}

/**
 * 服务端代理上传（multipart）：字节经服务端中转。
 * Worker 侧 `_store_bytes` 在 S3 失败时会自己回退 R2 binding / inline ——
 * 也就是说**这条路比直传更耐配错**，所以直传用不了时它是兜底而不是降级。
 *
 * 走 XHR 而不是 apiClient：要 `upload.onprogress` 给队列显示单张进度；
 * 鉴权头由 `xhr-upload.ts` 按 client.ts 同口径补上。
 */
async function uploadViaProxy(
  productKey: string,
  file: File,
  name: string,
  mediaKind: string,
  onProgress?: UploadProgressHandler,
): Promise<ProductMedia> {
  const form = new FormData();
  form.append("file", file);
  form.append("name", name);
  form.append("media_kind", mediaKind);
  const data = await xhrPostForm(
    `/products/${productKey}/media`,
    form,
    onProgress,
  );
  return data as ProductMedia;
}

/**
 * 上传结果 = 图片元数据 + **这次到底走没走成直传**。
 *
 * 为什么必须把这件事带出来：直传被拒（生产实测：S3 密钥填错，R2 回
 * `400 InvalidArgument: Credential access key has length 13, should be 32`）
 * 现在会**自动回退**到服务端代理，上传最终成功 —— 返回体若不带标记，界面只会看到
 * "成功"，于是"对象存储配错了、所有图都在经服务端中转"永远没人发现
 * （直传路径形同废弃，带宽/成本与预期不符）。
 */
export type UploadedProductMedia = ProductMedia & {
  /** true = 直传没用上，字节实际由服务端代理上传（落到哪看返回体里的 `storage`） */
  fellBackToProxy: boolean;
  /** 回退原因（`预签名失败…` / `直传被拒：HTTP 400` / `直传异常…`）；未回退为 undefined */
  fallbackReason?: string;
};

export function useUploadProductMedia(productKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      file: File;
      name: string;
      mediaKind: string;
      /** 覆盖 content-type（浏览器给空类型时由前端按扩展名推断，见 media-validation.ts） */
      contentType?: string;
      /** 单张进度（0–100）；不给就不报进度 */
      onProgress?: UploadProgressHandler;
    }): Promise<UploadedProductMedia> => {
      const { file, name, mediaKind, onProgress } = input;
      const contentType =
        input.contentType || file.type || "application/octet-stream";
      const meta = {
        owner_type: "product",
        owner_id: productKey,
        kind: "product_photo",
        media_kind: mediaKind,
        name,
        content_type: contentType,
        size: file.size,
        file_name: file.name,
      };
      const sha256 = await sha256Hex(file);

      // 非安全上下文（jsdom / HTTP 明文页面）没有 crypto.subtle：sha256 算不出来，
      // 而 register 缺它会 422（object_key 定键/去重都依赖它）⇒ 直传整条跳过，
      // 直接走服务端代传（服务端自己算哈希）——功能不缺失，只标记回退真相。
      if (sha256 === null) {
        const data = await uploadViaProxy(
          productKey,
          file,
          name,
          mediaKind,
          onProgress,
        );
        return {
          ...data,
          fellBackToProxy: true,
          fallbackReason:
            "当前环境不支持 crypto.subtle，无法预计算 sha256，跳过直传",
        };
      }

      // ① 直传优先：服务端只发短时效预签名 URL，**字节不经过服务端**
      //    （生产 R2 / 本地 MinIO 都是这条；没配对象存储时 configured=false）
      let presign: { configured: boolean; upload_url?: string } | null = null;
      let fallbackReason: string | undefined;
      try {
        const { data } = await apiClient.post<{
          configured: boolean;
          upload_url?: string;
        }>("/file-objects/presign", { ...meta, sha256 });
        presign = data;
      } catch (err) {
        // presign 自己失败（403/500/网络）⇒ 代理那条路可能还是好的，不整体失败
        fallbackReason = `预签名失败：${describeUploadError(err)}`;
      }

      if (presign?.configured && presign.upload_url) {
        let putOk = false;
        try {
          // 直传走 XHR：fetch 拿不到上传进度。预签名 URL 是绝对地址，
          // `xhrSend` 不会给它带我们的鉴权头（S3 会把多余头当成签名不符）。
          const res = await xhrSend({
            method: "PUT",
            url: presign.upload_url,
            body: file,
            headers: { "Content-Type": contentType },
            onProgress,
          });
          if (res.ok) putOk = true;
          else fallbackReason = `直传被拒：HTTP ${res.status}`;
        } catch (err) {
          // 网络异常 / CORS / 证书问题：同样不能整体失败
          fallbackReason = `直传异常：${describeUploadError(err)}`;
        }

        if (putOk) {
          // 字节已经落在对象存储里了。register 失败**绝不**回退重传：
          // 同一份字节会被服务端再写一次，而直传那条已经落盘 ⇒ 重复对象 + 重复流量；
          // 且 object_key 由 sha256 决定，用户重试是幂等的。
          // 所以这里明确报错（而不是偷偷走 multipart），让用户/界面知道"字节传上去了、登记没成"。
          try {
            const { data } = await apiClient.post<ProductMedia>(
              "/file-objects/register",
              { ...meta, sha256 },
            );
            return { ...data, fellBackToProxy: false };
          } catch (err) {
            throw new Error(
              `图片已直传成功，但登记失败（${describeUploadError(err)}）—— 请重试上传（字节不会重复写）`,
            );
          }
        }
      } else if (presign?.configured && !presign.upload_url) {
        // configured=true 却不给 URL：服务端状态不对，如实标记，别当成"没配对象存储"
        fallbackReason = "预签名未返回 upload_url";
      }

      // ② 兜底：服务端代传（multipart）。功能不缺失，只是字节经服务端中转。
      const media = await uploadViaProxy(
        productKey,
        file,
        name,
        mediaKind,
        onProgress,
      );
      if (!fallbackReason) {
        // 没配对象存储 = 设计如此（本来就走服务端），不算"回退"
        return { ...media, fellBackToProxy: false };
      }
      return { ...media, fellBackToProxy: true, fallbackReason };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: productKeys.all }),
  });
}

/** 取短时效直链（预签名 GET）；未配对象存储时返回 null。 */
export async function fetchFileDirectUrl(
  fileId: number,
): Promise<string | null> {
  const { data } = await apiClient.get<{ configured: boolean; url?: string }>(
    `/file-objects/${fileId}/url`,
  );
  return data.configured && data.url ? data.url : null;
}

export function usePatchFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id: number;
      name?: string;
      is_primary?: boolean;
      sort_order?: number;
    }) => {
      const { id, ...body } = input;
      const { data } = await apiClient.patch(`/file-objects/${id}`, body);
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: productKeys.all }),
  });
}

/**
 * 重排产品图：把**整个顺序**压成 0..n-1 逐条 PATCH。
 *
 * 为什么不是"交换两张图的 sort_order"：新上传的图 `sort_order` 都是默认 0，
 * 交换两个 0 等于没动。整体重排一次，就把"隐式顺序"固化成显式顺序；
 * 调用方只需把**期望的最终顺序**（含每条的位次）交进来，未变的位次不用发请求。
 */
export function useReorderProductMedia() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (order: { id: number; sort_order: number }[]) => {
      await Promise.all(
        order.map(({ id, sort_order }) =>
          apiClient.patch(`/file-objects/${id}`, { sort_order }),
        ),
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: productKeys.all }),
  });
}

export function useRetireFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await apiClient.delete(`/file-objects/${id}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: productKeys.all }),
  });
}

/** 图片取 blob → objectURL（鉴权头带不上 `<img>`，只能这样取） */
export function useFileObjectUrl(fileId: number | null) {
  return useQuery({
    queryKey: productKeys.fileUrl(fileId ?? 0),
    enabled: fileId !== null,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const res = await apiClient.get(`/file-objects/${fileId}/content`, {
        responseType: "blob",
      });
      return URL.createObjectURL(res.data as Blob);
    },
  });
}
