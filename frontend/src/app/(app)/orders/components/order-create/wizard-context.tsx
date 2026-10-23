"use client";

/**
 * 建单向导的 context（U-P1D2 拆分）。
 *
 * 主组件只负责编排与提交栏；5 个步骤组件通过 `useWizard()` 读同一份
 * 状态/派生/动作，避免把 40+ 个 props 逐层传递（也保证步骤之间不会出现
 * "这个步骤拿到的是旧闭包" 的偏差 —— 全部走同一次渲染的 context 值）。
 */
import { createContext, useContext } from "react";

import type { WizardApi } from "./types";

export const WizardContext = createContext<WizardApi | null>(null);

export function useWizard(): WizardApi {
  const value = useContext(WizardContext);
  if (value === null) {
    throw new Error("useWizard 必须在 <OrderCreateWizard> 内使用");
  }
  return value;
}
