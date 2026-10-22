/**
 * `product_photos` 的文本 ↔ 结构转换（纯函数）。
 *
 * 这三条约束只要破一条就会**静默丢用户数据**，所以逐条钉死：
 * 1. 重排只换位置 —— `caption` 之外的字段（`image` / `note` 等手写内容）原样保留；
 * 2. 数组里有认不出来的条目 ⇒ 拒绝重排（返回 null），而不是"过滤掉再写回"；
 * 3. 解析失败不抛异常 ⇒ 返回空列表/null，界面还能继续用（用户可能正在手改 JSON）。
 */
import { describe, expect, it } from "vitest";

import {
  parsePhotoEntries,
  removePhotoEntry,
  reorderPhotoEntries,
} from "../photo-entries";

const RAW = JSON.stringify(
  [
    { file_id: 31, caption: "成品外观" },
    { file_id: 32, caption: "侧面尺寸", image: "/legacy.png", note: "手写备注" },
    { file_id: 33, caption: "卷装重量" },
  ],
  null,
  2,
);

describe("parsePhotoEntries（读）", () => {
  it("按出图顺序取出 file_id 与 caption", () => {
    expect(parsePhotoEntries(RAW)).toEqual([
      { file_id: 31, caption: "成品外观" },
      { file_id: 32, caption: "侧面尺寸" },
      { file_id: 33, caption: "卷装重量" },
    ]);
  });

  it("空/未填 ⇒ 空列表", () => {
    expect(parsePhotoEntries(undefined)).toEqual([]);
    expect(parsePhotoEntries("")).toEqual([]);
    expect(parsePhotoEntries("   ")).toEqual([]);
  });

  it("JSON 写坏 ⇒ 空列表，不抛（用户可能正在手改）", () => {
    expect(parsePhotoEntries("[{file_id: 1,")).toEqual([]);
  });

  it("不是数组 ⇒ 空列表", () => {
    expect(parsePhotoEntries('{"file_id": 1}')).toEqual([]);
  });

  it("缺 file_id / 非数字的条目跳过，但不影响其它条目", () => {
    const raw = JSON.stringify([
      { file_id: 1, caption: "A" },
      { caption: "没有 id" },
      { file_id: "2", caption: "id 是字符串" },
      { file_id: 3 },
    ]);
    expect(parsePhotoEntries(raw)).toEqual([
      { file_id: 1, caption: "A" },
      { file_id: 3, caption: "" },
    ]);
  });
});

describe("reorderPhotoEntries（重排写回）", () => {
  it("倒序重排：只换位置，额外字段（image/note）跟着原对象走", () => {
    const written = reorderPhotoEntries(RAW, [
      { file_id: 33, caption: "卷装重量" },
      { file_id: 32, caption: "侧面尺寸" },
      { file_id: 31, caption: "成品外观" },
    ]);
    expect(written).not.toBeNull();
    const arr = JSON.parse(written!) as Record<string, unknown>[];
    expect(arr.map((e) => e.file_id)).toEqual([33, 32, 31]);
    // 关键：第 2 条的手写字段没有被"重新拼对象"吃掉
    expect(arr[1]).toMatchObject({
      file_id: 32,
      caption: "侧面尺寸",
      image: "/legacy.png",
      note: "手写备注",
    });
  });

  it("顺序没变也照常写回（幂等）", () => {
    const written = reorderPhotoEntries(
      RAW,
      parsePhotoEntries(RAW),
    );
    expect(JSON.parse(written!)).toEqual(JSON.parse(RAW));
  });

  it("有认不出来的条目 ⇒ null（宁可不改，也不静默丢掉）", () => {
    const mixed = JSON.stringify([
      { file_id: 1, caption: "A" },
      { image: "/x.png", caption: "手写条目（没有 file_id）" },
    ]);
    expect(
      reorderPhotoEntries(mixed, [{ file_id: 1, caption: "A" }]),
    ).toBeNull();
  });

  it("JSON 写坏 ⇒ null（调用方提示用户先修正）", () => {
    expect(reorderPhotoEntries("[{", [])).toBeNull();
  });

  it("空字段 + 空顺序 ⇒ 空数组文本", () => {
    expect(reorderPhotoEntries("", [])).toBe("[]");
  });

  it("输出是 2 空格缩进（用户还要在文本框里人工核对）", () => {
    const written = reorderPhotoEntries(RAW, parsePhotoEntries(RAW));
    expect(written).toContain('\n  {\n    "file_id": 31');
  });
});

describe("removePhotoEntry（移除）", () => {
  it("只删指定的那条，其余顺序不变", () => {
    const written = removePhotoEntry(RAW, 32);
    const arr = JSON.parse(written!) as { file_id: number }[];
    expect(arr.map((e) => e.file_id)).toEqual([31, 33]);
  });

  it("删到空 ⇒ 空串（而不是 []，否则渲染器会当成「有图但都无效」）", () => {
    const one = JSON.stringify([{ file_id: 7, caption: "只剩一张" }]);
    expect(removePhotoEntry(one, 7)).toBe("");
  });

  it("id 不存在 ⇒ 原样写回", () => {
    const written = removePhotoEntry(RAW, 999);
    expect(JSON.parse(written!)).toEqual(JSON.parse(RAW));
  });

  it("JSON 写坏 ⇒ null", () => {
    expect(removePhotoEntry("[{", 1)).toBeNull();
  });
});
