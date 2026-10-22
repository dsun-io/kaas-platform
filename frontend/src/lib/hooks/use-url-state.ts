"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * URL query ↔ 组件状态（P0-C 共享原语）。
 *
 * 为什么不用 `useSearchParams`：项目是 **静态导出**（`output: "export"`），
 * `useSearchParams` 在预渲染时必须被 `<Suspense>` 包住，否则整页 bail out，
 * 而"筛选条件进 URL"是列表页普遍需求，逐页包 Suspense 既重又容易漏。
 * 这里直接用 `window.location` + `history.replaceState`：
 * - **不触发路由跳转/重挂载**（不会把列表状态清空、不产生导航历史）；
 * - SSR 阶段无 `window`，读值返回 null / 写值 no-op，水合后由 effect 同步；
 * - 监听 `popstate`：浏览器前进/后退时 URL 变了但组件不重挂载，要同步回来。
 *
 * 只写字符串值；多值/复杂结构由调用方 JSON 编码或拆多个 key（保持 URL 可读）。
 */

/** 读单个 query 参数；SSR / 无 window 时返回 null。 */
export function readUrlParam(key: string): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(key);
}

/**
 * 批量写 query（`history.replaceState`，保留其它参数与 hash）。
 * 传 null / undefined / "" 表示删除该参数。
 */
export function writeUrlParams(
  patch: Readonly<Record<string, string | null | undefined>>,
): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined || value === "") {
      params.delete(key);
    } else {
      params.set(key, value);
    }
  }
  const query = params.toString();
  const next = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
  window.history.replaceState(window.history.state, "", next);
}

function readParam(key: string, fallback: string): string {
  return readUrlParam(key) ?? fallback;
}

/**
 * 单个 query 参数的双向绑定。
 *
 * @param key query 参数名（如 "status"）
 * @param defaultValue URL 上没有该参数时的值（也是删除参数时的等价状态）
 * @returns `[value, setValue]`；setValue 传 null/"" 会从 URL 删除该参数
 */
export function useUrlState(
  key: string,
  defaultValue = "",
): [string, (next: string | null) => void] {
  const [value, setValue] = useState(defaultValue);

  // 静态导出首屏（预渲染）没有真实 URL：水合后再读，避免 hydration mismatch。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 水合后同步 URL，必须 setState
    setValue(readParam(key, defaultValue));
  }, [key, defaultValue]);

  // 前进/后退改的是 URL，组件不会重挂载 —— 必须同步回 state。
  useEffect(() => {
    const onPopState = () => {
      setValue(readParam(key, defaultValue));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [key, defaultValue]);

  const set = useCallback(
    (next: string | null) => {
      setValue(next ?? "");
      writeUrlParams({ [key]: next });
    },
    [key],
  );

  return [value, set];
}
