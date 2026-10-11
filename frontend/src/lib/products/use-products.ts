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
 * - 单证**引用**这些图（`trade_doc_files.file_id`）⇒ 一次维护、重复使用。
 *
 * 为什么图片要经过 blob：`/file-objects/{id}/content` 需要 Bearer 鉴权，
 * `<img src>` 带不上头，所以统一用 axios 取 blob 再 `URL.createObjectURL`。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";

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
  version: number;
  created_at: string | null;
}

export interface ProductRow {
  product_key: string;
  name: string;
  name_en?: string;
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
      const { data } = await apiClient.get<{ items: ProductRow[]; media_kinds: Record<string, string> }>(
        "/products",
      );
      return data;
    },
  });
}

export function useProductProfile(productKey: string | null) {
  return useQuery({
    queryKey: productKeys.profile(productKey ?? ""),
    enabled: Boolean(productKey),
    queryFn: async () => {
      const { data } = await apiClient.get<{ product_key: string; info: Record<string, unknown> }>(
        `/products/${productKey}/profile`,
      );
      return data;
    },
  });
}

export function useSaveProductProfile(productKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (info: Record<string, unknown>) => {
      const { data } = await apiClient.put(`/products/${productKey}/profile`, { info });
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
      const { data } = await apiClient.get<{ items: ProductMedia[]; media_kinds: Record<string, string> }>(
        `/products/${productKey}/media`,
      );
      return data;
    },
  });
}

/** 文件 sha256（十六进制）—— 直传必须先算好，服务端据此定 object_key 并去重 */
async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function useUploadProductMedia(productKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { file: File; name: string; mediaKind: string }) => {
      const { file, name, mediaKind } = input;
      const contentType = file.type || "application/octet-stream";
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

      // ① 直传优先：服务端只发短时效预签名 URL，**字节不经过服务端**
      //    （生产 R2 / 本地 MinIO 都是这条；没配对象存储时 configured=false）
      const { data: presign } = await apiClient.post<{
        configured: boolean;
        upload_url?: string;
      }>("/file-objects/presign", { ...meta, sha256 });
      if (presign.configured && presign.upload_url) {
        const res = await fetch(presign.upload_url, {
          method: "PUT",
          body: file,
          headers: { "Content-Type": contentType },
        });
        if (!res.ok) throw new Error(`直传失败：HTTP ${res.status}`);
        const { data } = await apiClient.post<ProductMedia>("/file-objects/register", {
          ...meta,
          sha256,
        });
        return data;
      }

      // ② 回退：服务端代传（multipart）。功能不缺失，只是字节经服务端中转。
      const form = new FormData();
      form.append("file", file);
      form.append("name", name);
      form.append("media_kind", mediaKind);
      const { data } = await apiClient.post(`/products/${productKey}/media`, form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      return data as ProductMedia;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: productKeys.all }),
  });
}

/** 取短时效直链（预签名 GET）；未配对象存储时返回 null。 */
export async function fetchFileDirectUrl(fileId: number): Promise<string | null> {
  const { data } = await apiClient.get<{ configured: boolean; url?: string }>(
    `/file-objects/${fileId}/url`,
  );
  return data.configured && data.url ? data.url : null;
}

export function usePatchFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: number; name?: string; is_primary?: boolean }) => {
      const { id, ...body } = input;
      const { data } = await apiClient.patch(`/file-objects/${id}`, body);
      return data;
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
      const res = await apiClient.get(`/file-objects/${fileId}/content`, { responseType: "blob" });
      return URL.createObjectURL(res.data as Blob);
    },
  });
}
