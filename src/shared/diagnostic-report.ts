import { z } from "zod";
import { diagnosticCategories, diagnosticOperations, diagnosticStages, diagnosticSteps, diagnosticErrorTypes } from "./diagnostics";

export const diagnosticReportMaxBytes = 64 * 1024;
export const diagnosticReportRetentionMs = 30 * 24 * 60 * 60_000;
const build = z.string().regex(/^(?:[0-9a-f]{7,40}|development)$/).nullable();
const version = z.string().regex(/^\d{1,4}(?:\.\d{1,6}){0,3}$/).nullable();
const count = z.number().int().min(0).max(9999);
export const diagnosticReaderSchema = z.object({
  displayMode: z.enum(["pdf", "images"]),
  interactionMode: z.enum(["reading", "editing"]),
  pendingCount: count.nullable(),
  conflictCount: count.nullable(),
}).strict();
export type DiagnosticReader = z.infer<typeof diagnosticReaderSchema>;
export const diagnosticReportSchema = z.object({
  id: z.uuidv4(),
  version: z.literal(1),
  clientBuild: build,
  description: z.string().max(1000),
  environment: z.object({
    browser: z.enum(["edge", "firefox", "chrome", "safari", "unknown"]),
    browserVersion: version,
    system: z.enum(["ios", "android", "macos", "windows", "linux", "unknown"]),
    systemVersion: version,
    viewportWidth: z.number().int().min(0).max(32768),
    viewportHeight: z.number().int().min(0).max(32768),
    standalone: z.boolean(),
    serviceWorkerControlled: z.boolean(),
    onlineHint: z.boolean(),
  }).strict(),
  reader: diagnosticReaderSchema.nullable(),
  records: z.array(z.object({
    id: z.uuidv4(),
    time: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    operation: z.enum(diagnosticOperations),
    category: z.enum(diagnosticCategories),
    stage: z.enum(diagnosticStages),
    step: z.enum(diagnosticSteps).optional(),
    errorType: z.enum(diagnosticErrorTypes).optional(),
    serverBuild: build,
    requestId: z.uuidv4().nullable(),
    retryable: z.boolean(),
    count: count.min(1),
    engineVersion: z.string().regex(/^(pdfjs|pdfium)-[0-9]+\.[0-9]+\.[0-9]+(?:\.[0-9]+)?$/).max(64).optional(),
    pdfReason: z.enum(["encrypted", "corrupt-pdf", "engine-unavailable", "version-mismatch", "timeout", "render-failed", "document-failed"]).optional(),
  }).strict()).max(50),
}).strict();
export type DiagnosticReport = z.infer<typeof diagnosticReportSchema>;
export const diagnosticReceiptSchema = z.object({ id: z.uuidv4() }).strict();
