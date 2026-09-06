import pdfjsPackage from "pdfjs-dist/package.json" with { type: "json" };

// The worker imports fallback modules by filename. Keep that directory intact
// and version it together with the engine so PWA updates cannot mix decoders.
export const pdfJsWasmDirectory = `pdfjs/${pdfjsPackage.version}/wasm/`;
export const pdfJsDecoderFiles = [
  "jbig2.wasm",
  "jbig2_nowasm_fallback.js",
  "openjpeg.wasm",
  "openjpeg_nowasm_fallback.js",
  "qcms_bg.wasm",
];
export const pdfJsLicenseFiles = [
  "LICENSE_JBIG2", "LICENSE_PDFJS_JBIG2",
  "LICENSE_OPENJPEG", "LICENSE_PDFJS_OPENJPEG",
  "LICENSE_QCMS", "LICENSE_PDFJS_QCMS",
];
