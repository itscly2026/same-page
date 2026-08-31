export function canonicalScoreFileNameKey(fileName) {
  return fileName.normalize("NFC").toLocaleLowerCase("zh-CN");
}
