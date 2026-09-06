export async function saveInviteCard(svg: SVGSVGElement) {
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = svg.viewBox.baseVal.width * 3;
    canvas.height = svg.viewBox.baseVal.height * 3;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas_unavailable");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("export_failed")), "image/png"));
    const downloadUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = downloadUrl;
    anchor.download = "Same-Page-邀请卡.png";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 60_000);
  } finally {
    URL.revokeObjectURL(url);
  }
}
