// Release verification also runs before npm ci. Keep this path policy free of
// package imports while covering Vite chunks and versioned runtime decoders.
export function isReleaseScriptPath(scriptPath) {
  return /^\/assets\/[^/]+\.m?js$/.test(scriptPath)
    || /^\/pdfjs\/\d+\.\d+\.\d+\/wasm\/(?:jbig2|openjpeg)_nowasm_fallback\.js$/.test(scriptPath);
}

export function shellJavaScriptAssets(html) {
  return [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.js)"/g)]
    .map((match) => match[1])
    .filter((value, index, values) => values.indexOf(value) === index);
}

export function assetSetContainsBuildId(assetBodies, buildId) {
  return assetBodies.some((body) => body.includes(buildId));
}
