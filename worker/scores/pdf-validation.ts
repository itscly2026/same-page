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
    // Upload admission needs page count, not proof that every page can render.
    // Building operator lists here can exhaust the request before any resource
    // count is available. Leave page content decoding to the reader.

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
