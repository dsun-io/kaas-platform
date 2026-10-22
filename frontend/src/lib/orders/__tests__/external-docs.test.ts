/**
 * 已有单证导入纯逻辑（追加需求）：类型标签 / 文件校验 / multipart 组装 / 列表归一。
 */
import { describe, expect, it } from "vitest";

import {
  buildExternalDocForm,
  EXTERNAL_DOC_ACCEPT,
  EXTERNAL_DOC_MAX_BYTES,
  EXTERNAL_DOC_TYPES,
  externalDocTypeLabel,
  formatExternalDocSize,
  normalizeExternalDocList,
  validateExternalDocFile,
  type ExternalDoc,
} from "../external-docs";

function fileOf(name: string, type: string, size: number): File {
  return { name, type, size } as File;
}

function realFile(name: string, type: string): File {
  return new File([new Uint8Array(4)], name, { type });
}

describe("单证类型", () => {
  it("白名单覆盖用户口径：合同 / PO / 发票 / 装箱单 / 原产地证 / 其他", () => {
    expect(EXTERNAL_DOC_TYPES.map((item) => item.label)).toEqual([
      "合同",
      "采购订单 PO",
      "发票",
      "装箱单",
      "原产地证",
      "其他",
    ]);
    expect(externalDocTypeLabel("contract")).toBe("合同");
    expect(externalDocTypeLabel("po")).toBe("采购订单 PO");
    expect(externalDocTypeLabel("ci")).toBe("发票");
    expect(externalDocTypeLabel("pl")).toBe("装箱单");
    expect(externalDocTypeLabel("co")).toBe("原产地证");
    expect(externalDocTypeLabel("other")).toBe("其他");
  });

  it("未知/历史类型原样展示，空值表示未分类", () => {
    expect(externalDocTypeLabel("bl")).toBe("提单");
    expect(externalDocTypeLabel("weird_type")).toBe("weird_type");
    expect(externalDocTypeLabel(null)).toBe("未分类");
  });
});

describe("文件校验", () => {
  it("支持 PDF/图片/Word/Excel，拒绝其它类型", () => {
    expect(
      validateExternalDocFile(fileOf("contract.pdf", "application/pdf", 10)),
    ).toBeNull();
    expect(
      validateExternalDocFile(fileOf("scan.JPG", "image/jpeg", 10)),
    ).toBeNull();
    expect(
      validateExternalDocFile(
        fileOf(
          "packing.docx",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          10,
        ),
      ),
    ).toBeNull();
    expect(
      validateExternalDocFile(fileOf("list.xlsx", "application/vnd.ms-excel", 10)),
    ).toBeNull();
    expect(
      validateExternalDocFile(fileOf("a.exe", "application/octet-stream", 10)),
    ).toContain("支持 PDF");
  });

  it("上限 20MB（与后端 MAX_FILE_SIZE 一致）", () => {
    expect(EXTERNAL_DOC_MAX_BYTES).toBe(20 * 1024 * 1024);
    expect(
      validateExternalDocFile(
        fileOf("big.pdf", "application/pdf", EXTERNAL_DOC_MAX_BYTES + 1),
      ),
    ).toContain("文件太大");
  });

  it("accept 属性包含主要类型", () => {
    for (const ext of [".pdf", ".jpg", ".png", ".docx", ".xlsx"]) {
      expect(EXTERNAL_DOC_ACCEPT).toContain(ext);
    }
  });
});

describe("multipart 组装", () => {
  it("文件 + doc_type + order_id + customer_id + notes", () => {
    const form = buildExternalDocForm({
      file: realFile("contract.pdf", "application/pdf"),
      doc_type: "contract",
      order_id: 99,
      customer_id: 7,
      notes: "  客户签章扫描件  ",
    });
    expect(form.get("file")).toBeInstanceOf(File);
    expect(form.get("doc_type")).toBe("contract");
    expect(form.get("order_id")).toBe("99");
    expect(form.get("customer_id")).toBe("7");
    expect(form.get("notes")).toBe("客户签章扫描件");
  });

  it("可选字段为空时不 append（空 customer_id 会被后端当成真实值）", () => {
    const form = buildExternalDocForm({
      file: realFile("po.pdf", "application/pdf"),
      doc_type: "po",
      order_id: 99,
      customer_id: null,
      notes: "   ",
    });
    expect(form.get("customer_id")).toBeNull();
    expect(form.get("notes")).toBeNull();
    expect([...form.keys()].sort()).toEqual(["doc_type", "file", "order_id"]);
  });
});

describe("列表归一与展示", () => {
  const doc: ExternalDoc = {
    id: 1,
    doc_type: "contract",
    file_name: "contract.pdf",
    content_type: "application/pdf",
    file_size: 2048,
    order_id: 9,
    notes: null,
    created_at: "2026-10-20T00:00:00Z",
  };

  it("worker 返回数组；若包装成 {items} 也认；null 返回空数组", () => {
    expect(normalizeExternalDocList([doc])).toEqual([doc]);
    expect(normalizeExternalDocList({ items: [doc] })).toEqual([doc]);
    expect(normalizeExternalDocList(null)).toEqual([]);
    expect(normalizeExternalDocList(undefined)).toEqual([]);
  });

  it("大小展示：未知 —，其余 B/KB/MB", () => {
    expect(formatExternalDocSize(null)).toBe("—");
    expect(formatExternalDocSize(512)).toBe("512 B");
    expect(formatExternalDocSize(2048)).toBe("2.0 KB");
    expect(formatExternalDocSize(2 * 1024 * 1024)).toBe("2.0 MB");
  });
});
