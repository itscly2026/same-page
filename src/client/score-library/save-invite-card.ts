export async function createInviteCardFile(svg: SVGSVGElement) {
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
    return new File([blob], "Same-Page-邀请卡.png", { type: "image/png" });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function deliverInviteCard(file: File, share: boolean): Promise<"shared" | "saved" | "cancelled"> {
  if (share && navigator.canShare?.({ files: [file] }) && navigator.share) {
    try {
      await navigator.share({ files: [file] });
      return "shared";
    } catch (error) {
      if ((error instanceof DOMException || error instanceof Error) && error.name === "AbortError") return "cancelled";
      // File sharing can be blocked by the host browser; downloading remains available.
    }
  }
  const url = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return "saved";
}
