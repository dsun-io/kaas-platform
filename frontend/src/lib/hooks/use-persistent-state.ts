"use client";

import { useEffect, useState } from "react";

/**
 * 把轻量 UI 偏好（筛选条件、密度等）持久化到 localStorage。
 *
 * 注意：静态导出下 SSR 也会跑客户端组件，所以**不能**在 useState 初始化时读
 * localStorage（会 hydration mismatch）。这里先渲染 initial，挂载后再读回来，
 * 读取完成前不写回，避免把 initial 覆盖掉已存的值。
 */
export function usePersistentState<T>(
  key: string,
  initial: T,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(initial);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 挂载后恢复持久化值，必须 setState
      if (raw) setValue(JSON.parse(raw) as T);
    } catch {
      // 存储损坏/被禁用：静默退回默认值
    } finally {
      setHydrated(true);
    }
  }, [key]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // 隐私模式/配额满：不影响使用
    }
  }, [hydrated, key, value]);

  return [value, setValue];
}
