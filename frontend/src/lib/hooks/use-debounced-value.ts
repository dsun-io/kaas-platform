"use client";

import { useEffect, useState } from "react";

/**
 * 受控输入 → 延迟值（P0-C 共享原语）。
 *
 * 用途：搜索框/筛选输入"每键都发请求"是全站性能问题的主因之一
 * （见 UI 执行方案 P1-E「搜索防抖」）。调用方只维护"用户正在输入的值"，
 * 请求/URL 同步用延迟后的值。
 *
 * 设计取舍：
 * - **默认 300ms**：短到感觉即时，长到能吞掉连续击键；
 * - `delayMs <= 0` 退化为即时透传（便于测试/显式关闭防抖），不走 timer；
 * - 只做"延迟"，**不做节流/去重**：值最终一定到达，避免丢最后一次输入。
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState<T>(value);

  useEffect(() => {
    if (delayMs <= 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 退化为即时透传，必须 setState
      setDebounced(value);
      return;
    }
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
