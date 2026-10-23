/**
 * 关闭抽屉/弹窗后把焦点还给触发按钮。
 *
 * base-ui 在卸载 popup 时会执行自己的 finalFocus，可能与我们的 focus() 抢时序
 * （并发/动画下必现）⇒ 这里"重试到生效"，而不是一次性 setTimeout。
 */
export function restoreFocus(target: HTMLElement | null): void {
  if (!target) return;
  let attempts = 0;
  const tick = () => {
    target.focus();
    if (document.activeElement !== target && attempts < 10) {
      attempts += 1;
      window.setTimeout(tick, 16);
    }
  };
  window.setTimeout(tick, 0);
}
