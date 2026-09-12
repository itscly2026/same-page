import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { MAX_PDF_BYTES } from "../../src/shared/scores";
import { inspectPdf } from "./pdf-validation";

async function pdf(pages = 1) {
  const document = await PDFDocument.create();
  for (let index = 0; index < pages; index++) {
    document.addPage([200, 200]);
  }
  return new Uint8Array(await document.save()).buffer;
}

describe("minimal PDF upload admission", () => {
  it("preserves original bytes and their digest while reading page metadata", async () => {
    const data = await pdf(1);
    const original = data.slice(0);
    const result = await inspectPdf(data);
    expect(result.pageCount).toBe(1);
    const digest = await crypto.subtle.digest("SHA-256", original);
    expect(result.sha256).toBe(Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join(""));
    expect(data).toEqual(original);
  });

  it("retains the page limit", async () => {
    await expect(inspectPdf(await pdf(501))).rejects.toMatchObject({ code: "pdf_resource_limit" });
  });

  it("retains valid page counts", async () => {
    expect((await inspectPdf(await pdf(3))).pageCount).toBe(3);
  });

  it("rejects empty, oversized and unreadable input", async () => {
    await expect(inspectPdf(new ArrayBuffer(0))).rejects.toMatchObject({ code: "empty_pdf" });
    await expect(inspectPdf(new ArrayBuffer(MAX_PDF_BYTES + 1))).rejects.toMatchObject({ code: "pdf_too_large" });
    await expect(inspectPdf(new Uint8Array(new TextEncoder().encode("not a PDF")).buffer)).rejects.toMatchObject({ code: "invalid_pdf" });
  });
});
