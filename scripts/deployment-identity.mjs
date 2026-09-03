export function shellJavaScriptAssets(html) {
  return [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.js)"/g)]
    .map((match) => match[1])
    .filter((value, index, values) => values.indexOf(value) === index);
}

export function assetSetContainsBuildId(assetBodies, buildId) {
  return assetBodies.some((body) => body.includes(buildId));
}
