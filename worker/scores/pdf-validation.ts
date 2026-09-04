import { getDocumentProxy } from "unpdf";

import { MAX_PDF_BYTES, MAX_PDF_PAGES } from "../../src/shared/scores";

export class PdfValidationError extends Error {
  constructor(
    readonly code:
      | "empty_pdf"
      | "pdf_too_large"
      | "encrypted_pdf"
      | "invalid_pdf"
      | "pdf_resource_limit",
  ) {
    super(code);
  }
}

export async function inspectPdf(data: ArrayBuffer): Promise<{
  pageCount: number;
  sha256: string;
}> {
  if (data.byteLength === 0) {
    throw new PdfValidationError("empty_pdf");
  }
  if (data.byteLength > MAX_PDF_BYTES) {
    throw new PdfValidationError("pdf_too_large");
  }

  let document: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
  try {
    // PDF.js transfers its input buffer to the inlined worker. Keep the
    // original intact because that exact buffer is subsequently written to R2.
    document = await getDocumentProxy(new Uint8Array(data.slice(0)), {
      stopAtErrors: true,
      useSystemFonts: false,
    });
    if (!Number.isInteger(document.numPages) || document.numPages < 1) {
      throw new PdfValidationError("invalid_pdf");
    }

    if (document.numPages > MAX_PDF_PAGES) throw new PdfValidationError("pdf_resource_limit");
    // Parse every page and its drawing operators. This does not rasterize pixels
    // or guarantee identical fonts/rendering on every client device.
    let operations = 0;
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) ||
          viewport.width <= 0 || viewport.height <= 0 ||
          viewport.width > 14400 || viewport.height > 14400) {
        throw new PdfValidationError("pdf_resource_limit");
      }
      const operators = await page.getOperatorList();
      operations += operators.fnArray.length;
      if (operations > 1_000_000) throw new PdfValidationError("pdf_resource_limit");
      page.cleanup();
    }

    const digest = await crypto.subtle.digest("SHA-256", data);
    return {
      pageCount: document.numPages,
      sha256: toHex(new Uint8Array(digest)),
    };
  } catch (error) {
    if (error instanceof PdfValidationError) {
      throw error;
    }
    if (
      error instanceof Error &&
      (error.name === "PasswordException" ||
        /password|encrypted/i.test(error.message))
    ) {
      throw new PdfValidationError("encrypted_pdf");
    }
    throw new PdfValidationError("invalid_pdf");
  } finally {
    await document?.loadingTask.destroy();
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
