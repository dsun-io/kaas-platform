"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { normalizeApiError } from "@/lib/api/api-error";

/**
 * 异步动作（mutation）→ pending / 错误 / 统一错误出口（P0-C 共享原语）。
 *
 * 解决两类全站问题（UI 执行方案 P0-B B2/B4）：
 * 1. **失败静默**：页面裸调 `mutateAsync` 不 catch ⇒ 用户点了没反应；
 * 2. **防重缺失**：mutation 进行中按钮仍可点 ⇒ 重复下单/重复群发。
 *
 * 口径：
 * - `run` **永不抛**（内部 catch），失败返回 `undefined`；调用方看 `error`/返回值即可；
 * - `error` 是给人看的中文文案（`normalizeApiError`：后端 message/detail 优先）；
 * - **默认不 toast**：`apiClient` 的响应拦截器已经统一 `handleApiError`（含 toast），
 *   再弹一次就是双 toast。走裸 fetch / `silent: true` 的调用方显式传
 *   `toastOnError: true` 才弹；
 * - 组件卸载后不再 setState / 回调，避免 React 警告与"卸载后 toast"。
 *
 * 典型用法：
 * ```tsx
 * const remove = useAsyncAction((id: number) => apiClient.delete(`/products/${id}`), {
 *   onSuccess: () => qc.invalidateQueries({ queryKey: ["products"] }),
 *   onError: (msg) => setDialogError(msg),
 * });
 * <AsyncButton pending={remove.pending} onClick={() => remove.run(id)}>删除</AsyncButton>
 * {remove.error && <ErrorState message={remove.error} onRetry={() => remove.run(id)} />}
 * ```
 */

export interface UseAsyncActionOptions<TArgs extends unknown[], TResult> {
  /** 成功后回调（组件已卸载则不调用） */
  onSuccess?: (result: TResult, ...args: TArgs) => void;
  /** 失败回调；message 已归一化为中文文案 */
  onError?: (message: string, error: unknown, ...args: TArgs) => void;
  /**
   * 失败时是否额外 `toast.error`（默认 false：apiClient 拦截器已统一提示，
   * 重复 toast 是真实回归；裸 fetch / silent 请求才需要打开）。
   */
  toastOnError?: boolean;
  /** 自定义错误文案提取（默认 `normalizeApiError(error).message`） */
  errorMessage?: (error: unknown) => string;
}

export interface AsyncAction<TArgs extends unknown[], TResult> {
  /** 触发动作；返回成功结果，失败返回 undefined（不抛） */
  run: (...args: TArgs) => Promise<TResult | undefined>;
  /** 进行中（用于禁用按钮/防重） */
  pending: boolean;
  /** 最近一次失败文案；成功或 reset 后清空 */
  error: string | null;
  /** 清空 error（例如关闭弹窗时） */
  reset: () => void;
}

export function useAsyncAction<TArgs extends unknown[] = [], TResult = void>(
  action: (...args: TArgs) => Promise<TResult>,
  options: UseAsyncActionOptions<TArgs, TResult> = {},
): AsyncAction<TArgs, TResult> {
  // action/options 放到 ref：调用方内联函数不会让 run 每次渲染都变（useEffect 依赖友好）。
  const actionRef = useRef(action);
  const optionsRef = useRef(options);
  const aliveRef = useRef(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    actionRef.current = action;
    optionsRef.current = options;
  }, [action, options]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const run = useCallback(async (...args: TArgs) => {
    setPending(true);
    setError(null);
    try {
      const result = await actionRef.current(...args);
      if (aliveRef.current) optionsRef.current.onSuccess?.(result, ...args);
      return result;
    } catch (rawError) {
      const { errorMessage } = optionsRef.current;
      const message = errorMessage
        ? errorMessage(rawError)
        : normalizeApiError(rawError).message;
      if (aliveRef.current) {
        setError(message);
        optionsRef.current.onError?.(message, rawError, ...args);
        if (optionsRef.current.toastOnError === true) toast.error(message);
      }
      return undefined;
    } finally {
      if (aliveRef.current) setPending(false);
    }
  }, []);

  const reset = useCallback(() => setError(null), []);

  return { run, pending, error, reset };
}
