"use client";

/**
 * `useMutation` + 页内错误态（ui:patterns R4 `use-mutation-on-error`）。
 *
 * 为什么不是简单加个空 `onError`：失败原因必须能被界面看到。apiClient 的响应拦截器
 * 已经统一 toast（**不要再重复 toast**），这里把归一化后的中文文案留给调用方，
 * 由页面/弹窗渲染成 `role="alert"` 错误态（或接 `useAsyncAction`）。
 *
 * 成功路径完全不变：`onSuccess`/`mutationFn` 原样透传，本包装只做错误文案记录；
 * 返回对象仍是 `UseMutationResult`（额外带 `errorMessage`/`clearError`），
 * 调用方不需要改现有 `mutateAsync`/`isPending` 用法。
 */
import { useState } from "react";
import {
  useMutation,
  type UseMutationOptions,
  type UseMutationResult,
} from "@tanstack/react-query";

import { normalizeApiError } from "@/lib/api/api-error";

export type MutationWithErrorResult<TData, TError, TVariables, TContext> =
  UseMutationResult<TData, TError, TVariables, TContext> & {
    /** 最近一次失败的中文文案（成功/clearError 后清空）；apiClient 已 toast，本字段供页内错误态 */
    errorMessage: string | null;
    clearError: () => void;
  };

export function useMutationWithError<
  TData = unknown,
  TError = Error,
  TVariables = void,
  TContext = unknown,
>(
  options: UseMutationOptions<TData, TError, TVariables, TContext>,
): MutationWithErrorResult<TData, TError, TVariables, TContext> {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const mutation = useMutation<TData, TError, TVariables, TContext>({
    ...options,
    onError: (error, variables, context, mutationInstance) => {
      setErrorMessage(normalizeApiError(error).message);
      options.onError?.(error, variables, context, mutationInstance);
    },
  });
  return {
    ...mutation,
    errorMessage,
    clearError: () => setErrorMessage(null),
  };
}
