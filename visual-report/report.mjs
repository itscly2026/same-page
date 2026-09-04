export function createVisualReportManifest({ commit, generatedAt, captures, workingTreeDirty = false }) {
  return {
    schemaVersion: 2,
    workingTreeDirty,
    sampleProvenance: "本仓库自行生成的虚构排版与批注，未复制私人或外部乐谱。",
    deviceGates: ["真实 iPad Safari 与旋转", "Pencil 笔迹", "真实软键盘与触控", "安装后的离线与生产更新"],
    app: "Same Page",
    commit,
    generatedAt,
    captures,
  };
}

export function renderVisualReportHtml(manifest) {
  const cards = manifest.captures
    .map(
      (capture) => `
        <article class="capture-card">
          <div class="capture-heading">
            <div>
              <p>${escapeHtml(capture.deviceLabel)}</p>
              <h2>${escapeHtml(capture.title)}</h2>
            </div>
            <code>${escapeHtml(capture.id)}</code>
          </div>
          <p class="capture-description">${escapeHtml(capture.description)}</p>
          <a href="${escapeHtml(capture.screenshot)}">
            <img src="${escapeHtml(capture.screenshot)}" alt="${escapeHtml(capture.title)}" loading="lazy">
          </a>
          <dl>
            <div><dt>App viewport</dt><dd>${capture.viewport.width} × ${capture.viewport.height}</dd></div>
            <div><dt>PNG pixels</dt><dd>${capture.pixels.width} × ${capture.pixels.height}</dd></div>
            <div><dt>Identity</dt><dd>${escapeHtml(capture.identity ?? "unspecified")}</dd></div>
            <div><dt>Ready</dt><dd><code>${escapeHtml(JSON.stringify(capture.expectedReady ?? {}))}</code></dd></div>
            <div><dt>Injected failures</dt><dd>${escapeHtml(JSON.stringify(capture.diagnostics?.intentionalFailures ?? []))}</dd></div>
            <div><dt>Route</dt><dd><code>${escapeHtml(capture.route)}</code></dd></div>
          </dl>
        </article>`,
    )
    .join("");

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Same Page · iPad 视觉报告</title>
    <style>
      :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; color: #15363a; background: #f5f2e9; }
      * { box-sizing: border-box; }
      body { margin: 0; }
      header { padding: 56px max(24px, 6vw) 30px; border-bottom: 1px solid #d5d0c2; }
      header p { margin: 0 0 8px; color: #66777a; }
      header h1 { margin: 0; font-size: clamp(2rem, 5vw, 4.5rem); font-weight: 580; letter-spacing: -0.045em; }
      header dl { display: flex; flex-wrap: wrap; gap: 10px 30px; margin: 28px 0 0; }
      header dl div, .capture-card dl div { display: flex; gap: 8px; }
      dt { color: #6d7b7d; } dd { margin: 0; }
      main { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); gap: 28px; padding: 36px max(24px, 6vw) 80px; }
      .capture-card { align-self: start; overflow: hidden; border: 1px solid #d5d0c2; border-radius: 18px; background: #fffef9; box-shadow: 0 14px 35px rgb(31 57 60 / 8%); }
      .capture-heading { display: flex; justify-content: space-between; gap: 20px; padding: 22px 22px 0; }
      .capture-heading p { margin: 0 0 4px; color: #6d7b7d; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.08em; }
      .capture-heading h2 { margin: 0; font-size: 1.25rem; }
      .capture-heading code { align-self: start; color: #496468; font-size: 0.72rem; }
      .capture-description { min-height: 2.7em; margin: 10px 22px 18px; color: #52686c; }
      .capture-card > a { display: block; border-block: 1px solid #e4dfd2; background: #1c2d30; }
      img { display: block; width: 100%; height: auto; }
      .capture-card dl { display: grid; gap: 6px; margin: 0; padding: 16px 22px 20px; font-size: 0.82rem; }
      dd { overflow-wrap: anywhere; min-width: 0; }
      code { font-family: "SFMono-Regular", Consolas, monospace; }
    </style>
  </head>
  <body>
    <header>
      <p>基于当前 App 与确定性虚构数据生成</p>
      <h1>Same Page · iPad 视觉报告</h1>
      <dl>
        <div><dt>Commit</dt><dd><code>${escapeHtml(manifest.commit)}</code></dd></div>
        <div><dt>Generated</dt><dd>${escapeHtml(manifest.generatedAt)}</dd></div>
        <div><dt>Uncommitted changes</dt><dd>${manifest.workingTreeDirty ? "yes" : "no"}</dd></div>
        <div><dt>Scenes</dt><dd>${manifest.captures.length}</dd></div>
      </dl>
      <p>${escapeHtml(manifest.sampleProvenance)}</p>
      <p>浏览器自动化不能替代人工设备验收：${escapeHtml((manifest.deviceGates ?? []).join("、"))}（#9）。</p>
    </header>
    <main>${cards}</main>
  </body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
