/**
 * 订单附件 / 到账截图上传规则（§13.3）。
 *
 * 后端口径：订单附件 multipart 只认 file + name（kind 恒 other，传别的会 422）；
 * 到账截图 PNG/JPG/PDF ≤16MB。这里钉住前端先拦的规则与 FormData 字段名。
 */
import { describe, expect, it } from "vitest";

import {
  attachmentDisplayName,
  attachmentKindFromName,
  attachmentKindLabel,
  buildOrderAttachmentForm,
  buildReceiptFileForm,
  formatFileSize,
  ORDER_ATTACHMENT_MAX_BYTES,
  RECEIPT_FILE_MAX_BYTES,
  validateAttachmentFile,
  validateReceiptFile,
} from "../order-attachments";

/** 校验只读 name/type/size —— 用轻量替身，避免为 20MB 上限真的分配内存。 */
function fileOf(name: string, type: string, size: number): File {
  return { name, type, size } as File;
}

/** FormData 场景必须是真 File/Blob。 */
function realFile(name: string, type: string): File {
  return new File([new Uint8Array(4)], name, { type });
}

describe("附件类别与命名", () => {
  it("类别中文标签 + 上传名带类别前缀 + 从名字反推类别", () => {
    expect(attachmentKindLabel("contract")).toBe("合同");
    expect(attachmentKindLabel("po")).toBe("PO / 客户订单");
    expect(attachmentKindLabel("lc")).toBe("信用证");
    expect(attachmentKindLabel("weird")).toBe("weird");

    const name = attachmentDisplayName("lc", " 信用证扫描件 ", "lc.pdf");
    expect(name).toBe("信用证 · 信用证扫描件");
    expect(attachmentKindFromName(name)).toBe("lc");
    expect(attachmentKindFromName("客户合同.pdf")).toBe("other");
    expect(attachmentDisplayName("po", "", "po-001.pdf")).toBe(
      "PO / 客户订单 · po-001.pdf",
    );
  });
});

describe("文件校验", () => {
  it("允许 PDF/JPG/PNG，其它类型拒绝", () => {
    expect(validateAttachmentFile(fileOf("a.pdf", "application/pdf", 10))).toBeNull();
    expect(validateAttachmentFile(fileOf("a.jpg", "image/jpeg", 10))).toBeNull();
    expect(validateAttachmentFile(fileOf("a.png", "image/png", 10))).toBeNull();
    expect(
      validateAttachmentFile(fileOf("a.docx", "application/msword", 10)),
    ).toContain("只支持");
    // 浏览器偶尔给空 MIME：按扩展名兜底
    expect(validateAttachmentFile(fileOf("a.PDF", "", 10))).toBeNull();
  });

  it("订单附件默认 20MB；到账截图按 16MB 上限", () => {
    expect(ORDER_ATTACHMENT_MAX_BYTES).toBe(20 * 1024 * 1024);
    expect(RECEIPT_FILE_MAX_BYTES).toBe(16 * 1024 * 1024);
    expect(
      validateReceiptFile(fileOf("big.pdf", "application/pdf", RECEIPT_FILE_MAX_BYTES + 1)),
    ).toContain("文件太大");
    expect(
      validateAttachmentFile(
        fileOf("big.pdf", "application/pdf", ORDER_ATTACHMENT_MAX_BYTES + 1),
      ),
    ).toContain("文件太大");
  });
});

describe("FormData 组装", () => {
  it("订单附件字段 = file + name；不传 kind（后端只接受 other）", () => {
    const file = realFile("contract.pdf", "application/pdf");
    const form = buildOrderAttachmentForm(file, " 合同 · 正式版 ");
    expect(form.get("file")).toBeInstanceOf(File);
    expect(form.get("name")).toBe("合同 · 正式版");
    expect(form.get("kind")).toBeNull();
  });

  it("name 为空时不传 name 字段（后端用文件名兜底）", () => {
    const form = buildOrderAttachmentForm(
      realFile("a.pdf", "application/pdf"),
      "   ",
    );
    expect(form.get("name")).toBeNull();
  });

  it("到账截图字段名固定 file", () => {
    const form = buildReceiptFileForm(
      realFile("receipt.png", "image/png"),
    );
    expect(form.get("file")).toBeInstanceOf(File);
    expect([...form.keys()]).toEqual(["file"]);
  });
});

describe("文件大小展示", () => {
  it("B/KB/MB 三档", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2048)).toBe("2.0 KB");
    expect(formatFileSize(2 * 1024 * 1024)).toBe("2.0 MB");
    expect(formatFileSize(-1)).toBe("—");
  });
});