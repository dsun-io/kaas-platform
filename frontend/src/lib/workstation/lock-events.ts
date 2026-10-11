/**
 * 「工位未开通」事件总线 —— 一个极小的模块级发布/订阅。
 *
 * 为什么需要它：拦截发生在 **axios 拦截器**（`lib/api/error-handler.ts`，非 React 环境），
 * 而渲染引导页的是 React 组件。两者之间不能直接互相 import（工具层不该依赖 React 树），
 * 用一条"工位被拒"的事件解耦：
 *   拦截器 publish → TeamProvider 订阅（刷新快照 + 记下被拒工位）→ WorkstationGate 渲染引导页。
 *
 * 为什么不在这里做 toast：未开通是**可预期的业务状态**，弹通用错误会让用户以为系统坏了；
 * 引导页才是正确反馈（docs/FRONTEND_PRODUCTION_READINESS.md A.2）。
 */
export type WorkstationLockListener = (workstation: string | null) => void;

/**
 * 未开通工位的业务错误码。
 *
 * 刻意放在这个**零依赖**的叶子模块里（而不是 `visibility.ts`）：
 * axios 拦截器要用它，而 `visibility.ts` 会 import 契约（连带 zod）——
 * 让它进主包不值得。`visibility.ts` 会再导出一次，业务代码照旧从那里取。
 */
export const WORKSTATION_NOT_SUBSCRIBED = "WORKSTATION_NOT_SUBSCRIBED";

const listeners = new Set<WorkstationLockListener>();

/** 后端拒绝了一个未开通的工位（404 WORKSTATION_NOT_SUBSCRIBED） */
export function notifyWorkstationLocked(workstation: string | null): void {
  for (const listener of listeners) {
    try {
      listener(workstation);
    } catch {
      // 单个订阅者出错不能影响其它订阅者（也不能把异常丢回拦截器）
    }
  }
}

/** 订阅"工位被拒"事件；返回取消订阅函数（useEffect 清理用）。 */
export function subscribeWorkstationLock(
  listener: WorkstationLockListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 清空拦截记录（重新拉取成功、或用户主动重试时） */
export function clearWorkstationLock(): void {
  notifyWorkstationLocked(null);
}

/** 仅测试用：清空所有订阅者，避免用例之间互相污染 */
export function resetWorkstationLockListeners(): void {
  listeners.clear();
}
