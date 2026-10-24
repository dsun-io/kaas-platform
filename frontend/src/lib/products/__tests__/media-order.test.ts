/**
 * 产品图库排序规则（纯函数）—— 与后端 `_FILE_ORDER_BY` 同口径。
 *
 * 为什么规则要在这里钉死：拖拽的落点映射在 jsdom 里算不准（没有布局），
 * 但"松手之后该不该发请求、发哪些"是可以精确断言的 —— 这正是容易出 bug 的地方
 * （多发 → 用户看到一串 toast；少发 → 刷新后顺序跳回去）。
 *
 * 2026-10-24 追加 `insertUploadedMedia`：上传成功后把新图**直接并进缓存**，
 * 不再依赖那次可能撞上 502 的重拉（用户症状："上传成功后图不显示"）。
 */
import { describe, expect, it } from "vitest";

import type { ProductMedia } from "@/lib/products/use-products";

import {
  insertUploadedMedia,
  pinPrimaryFirst,
  reorderPatches,
} from "../media-order";

function media(over: Partial<ProductMedia> & { id: number }): ProductMedia {
  return {
    name: `图 ${over.id}`,
    media_kind: "production",
    kind: "product_photo",
    storage: "s3",
    object_key: `k/${over.id}`,
    content_type: "image/png",
    file_size: 1024,
    is_primary: false,
    sort_order: 0,
    version: 1,
    created_at: null,
    ...over,
  };
}

const ids = (items: ProductMedia[]) => items.map((m) => m.id);
const orders = (items: ProductMedia[]) => items.map((m) => m.sort_order);

describe("pinPrimaryFirst（主图恒排最前）", () => {
  it("主图已在第一位 ⇒ 原样返回（同一引用，调用方据此跳过重排）", () => {
    const items = [media({ id: 1, is_primary: true }), media({ id: 2 })];
    expect(pinPrimaryFirst(items)).toBe(items);
  });

  it("没有主图 ⇒ 原样返回", () => {
    const items = [media({ id: 1 }), media({ id: 2 })];
    expect(pinPrimaryFirst(items)).toBe(items);
  });

  it("主图被拖到中间 ⇒ 提回第一位，其余保持相对顺序", () => {
    const items = [
      media({ id: 1 }),
      media({ id: 2, is_primary: true }),
      media({ id: 3 }),
    ];
    expect(ids(pinPrimaryFirst(items))).toEqual([2, 1, 3]);
  });

  it("主图被拖到最后 ⇒ 提回第一位", () => {
    const items = [
      media({ id: 1 }),
      media({ id: 2 }),
      media({ id: 3, is_primary: true }),
    ];
    expect(ids(pinPrimaryFirst(items))).toEqual([3, 1, 2]);
  });

  it("空列表不炸", () => {
    expect(pinPrimaryFirst([])).toEqual([]);
  });

  it("不改原数组（调用方可能还要拿去回滚）", () => {
    const items = [media({ id: 1 }), media({ id: 2, is_primary: true })];
    const before = ids(items);
    pinPrimaryFirst(items);
    expect(ids(items)).toEqual(before);
  });
});

describe("reorderPatches（把展示顺序压成 0..n-1）", () => {
  it("全部位次都变 ⇒ 每条都发", () => {
    const items = [
      media({ id: 7, sort_order: 2 }),
      media({ id: 8, sort_order: 0 }),
      media({ id: 9, sort_order: 1 }),
    ];
    expect(reorderPatches(items)).toEqual([
      { id: 7, sort_order: 0 },
      { id: 8, sort_order: 1 },
      { id: 9, sort_order: 2 },
    ]);
  });

  it("位次没变 ⇒ 空数组（一次拖拽不该 PATCH 二十次）", () => {
    const items = [
      media({ id: 7, sort_order: 0 }),
      media({ id: 8, sort_order: 1 }),
    ];
    expect(reorderPatches(items)).toEqual([]);
  });

  it("只动了一条 ⇒ 只发一条", () => {
    const items = [
      media({ id: 7, sort_order: 0 }),
      media({ id: 8, sort_order: 5 }),
    ];
    expect(reorderPatches(items)).toEqual([{ id: 8, sort_order: 1 }]);
  });

  it("新图 sort_order 都是 0（后端默认值）⇒ 除第一位外全部重写，避免「交换两个 0 等于没动」", () => {
    const items = [media({ id: 1 }), media({ id: 2 }), media({ id: 3 })];
    expect(reorderPatches(items)).toEqual([
      // 第一条本来就该是 0，已经对了 ⇒ 不白发一次
      { id: 2, sort_order: 1 },
      { id: 3, sort_order: 2 },
    ]);
  });

  it("位次永远落在 0..n-1（后端只接受 0–9999，别越界）", () => {
    const items = Array.from({ length: 12 }, (_, i) =>
      media({ id: i + 1, sort_order: 9999 - i }),
    );
    const patches = reorderPatches(items);
    expect(patches.map((p) => p.sort_order)).toEqual(
      Array.from({ length: 12 }, (_, i) => i),
    );
  });
});

describe("insertUploadedMedia（上传成功 ⇒ 立刻并进缓存）", () => {
  it("空图库上传第一张（后端会自动设主图）⇒ 缓存里就有它", () => {
    const next = insertUploadedMedia(
      [],
      media({ id: 91, is_primary: true, sort_order: 0 }),
    );
    expect(ids(next)).toEqual([91]);
    // 主图固定第一位：第一张必须排 0
    expect(next[0]).toMatchObject({ id: 91, is_primary: true, sort_order: 0 });
  });

  it("已有列表 ⇒ 追加到末尾，不覆盖旧图", () => {
    const items = [
      media({ id: 1, is_primary: true, sort_order: 0 }),
      media({ id: 2, sort_order: 1 }),
    ];
    const next = insertUploadedMedia(items, media({ id: 3, sort_order: 0 }));
    expect(ids(next)).toEqual([1, 2, 3]);
  });

  it("主图恒排最前：新图被后端标成主图时提到第一位，其余保持相对顺序", () => {
    const items = [
      media({ id: 1, is_primary: true, sort_order: 0 }),
      media({ id: 2, sort_order: 1 }),
    ];
    const next = insertUploadedMedia(
      items,
      media({ id: 9, is_primary: true, sort_order: 0 }),
    );
    expect(ids(next)).toEqual([9, 1, 2]);
    expect(next.filter((m) => m.is_primary)).toHaveLength(2);
  });

  it("sort_order 重建成 0..n-1（与后端「整个顺序压平」同口径）", () => {
    const items = [
      media({ id: 1, is_primary: true, sort_order: 7 }),
      media({ id: 2, sort_order: 9 }),
    ];
    const next = insertUploadedMedia(items, media({ id: 3, sort_order: 0 }));
    // 旧图位次 7/9 都不对 ⇒ 全部重写成 0..n-1
    expect(orders(next)).toEqual([0, 1, 2]);
  });

  it("位次本来就对的旧图不重建（引用不变，避免无意义重渲染）", () => {
    const items = [
      media({ id: 1, is_primary: true, sort_order: 0 }),
      media({ id: 2, sort_order: 1 }),
    ];
    const next = insertUploadedMedia(items, media({ id: 3, sort_order: 0 }));
    expect(orders(next)).toEqual([0, 1, 2]);
    expect(next[0]).toBe(items[0]);
    expect(next[1]).toBe(items[1]);
    // 只有新图自身位次被改写（0 → 2），所以它是新对象
    expect(next[2]).not.toBe(items[2]);
  });

  it("同 id 去重（重复上传/重试不会多出一张一模一样的卡）", () => {
    const items = [
      media({ id: 1, is_primary: true }),
      media({ id: 2, sort_order: 1 }),
    ];
    const next = insertUploadedMedia(
      items,
      media({ id: 2, name: "改名后的同一张" }),
    );
    expect(ids(next)).toEqual([1, 2]);
    expect(next.find((m) => m.id === 2)?.name).toBe("改名后的同一张");
  });

  it("不改原数组（失败回滚/其它缓存写入还能用原值）", () => {
    const items = [media({ id: 1 })];
    const before = ids(items);
    insertUploadedMedia(items, media({ id: 2 }));
    expect(ids(items)).toEqual(before);
  });
});
