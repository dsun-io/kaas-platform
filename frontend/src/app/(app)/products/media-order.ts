/**
 * 产品图库的**排序规则**（纯函数）。
 *
 * 单独成文件而不是塞进 `product-images.tsx`：
 *  · 规则本身与 React 无关，放进组件文件里会让单测被迫拉起
 *    dnd-kit / react-query / axios 整条依赖链，测一个数组变换不值这个价；
 *  · 这些规则有**后端口径**要对照，未来加规则（例如按类型分组）时
 *    改动点应该在一个一眼能读完的文件里。
 *
 * 后端口径：`worker/src/ws_files.py` `_FILE_ORDER_BY = "is_primary DESC, sort_order, id"`。
 */
import type { ProductMedia } from "@/lib/products/use-products";

/**
 * 主图恒排最前。
 *
 * 后端列表按 `is_primary DESC, sort_order, id` 排 —— 主图不管 `sort_order` 多大
 * 都会被顶到第一位。前端必须按同一口径收敛，否则会出现两种撕裂：
 *  · 用户把别的图拖到主图前面，界面显示成功，刷新后又跳回去；
 *  · 乐观更新写进缓存的顺序和服务端算出来的顺序不一致，卡片位置来回抖。
 *
 * 收敛方式：主图提到第一位，其余图**保持用户拖出来的相对顺序**
 * （落到"主图之后的第一位"，而不是原地不动 —— 那样等于拖了没反应）。
 *
 * 返回 `items` 本身（同一引用）表示无需调整，调用方据此跳过无意义的重排请求。
 */
export function pinPrimaryFirst(items: ProductMedia[]): ProductMedia[] {
  const index = items.findIndex((m) => m.is_primary);
  if (index <= 0) return items;
  const next = [...items];
  const [primary] = next.splice(index, 1);
  if (!primary) return items;
  next.unshift(primary);
  return next;
}

/**
 * 把「期望的展示顺序」翻译成需要 PATCH 的 `{id, sort_order}` 列表。
 *
 * 只返回位次真的变了的那些：
 * - 新上传的图 `sort_order` 都是默认 0，交换两个 0 等于没动，
 *   所以必须把**整个顺序**压成 0..n-1 显式落库，而不是"只交换两张图的值"；
 * - 但位次没变的就不要发请求（一次拖拽可能只动两张，没必要 PATCH 二十次）。
 *
 * 返回空数组 ⇒ 顺序其实没变（例如拖回原处、或某张图被收敛回原位），
 * 调用方应当直接返回，不要发请求也不要弹 toast。
 */
export function reorderPatches(
  items: ProductMedia[],
): { id: number; sort_order: number }[] {
  const patches: { id: number; sort_order: number }[] = [];
  items.forEach((media, index) => {
    if (media.sort_order !== index) patches.push({ id: media.id, sort_order: index });
  });
  return patches;
}
