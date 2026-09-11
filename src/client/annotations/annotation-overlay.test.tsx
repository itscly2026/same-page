import Dexie from "dexie";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AnnotationLayerSummary } from "../../shared/annotations";
import {
  annotationRecordKey,
  localDatabase,
  type LocalAnnotationRecord,
} from "../platform/local-database";
import {
  activateAuthenticatedLocalOwner,
  authenticatedLocalOwnerKey,
  createLocalWorkspace,
} from "../platform/local-workspace";
import * as annotationState from "./annotation-state";
import { AnnotationEditor } from "./annotation-editor";
import {
  AnnotationOverlay,
  type AnnotationOverlayInteraction,
  type AnnotationTool,
} from "./annotation-overlay";

const choirId = "choir-1";
const scoreId = "score-1";
const workspace = createLocalWorkspace(
  authenticatedLocalOwnerKey("user-1"),
  choirId,
  scoreId,
);
const scopeKey = workspace.scopeKey;
let editor: AnnotationEditor;
const activeLayerId = "11111111-1111-4111-8111-111111111111";
const otherLayerId = "22222222-2222-4222-8222-222222222222";

const layers: AnnotationLayerSummary[] = [
  {
    id: activeLayerId,
    kind: "shared",
    sharedSlot: "E",
    name: "Ensemble",
    sortOrder: 0,
    subscribed: false,
    subscriptionSource: "product",
    displayColor: "#a12652",
    colorSource: "product",
    adminDefaultColor: "#a12652",
    driveSubscribed: null,
    driveColorOverride: null,
    scoreSubscriptionOverride: null,
    canEdit: true,
  },
  {
    id: otherLayerId,
    kind: "shared",
    sharedSlot: "B",
    name: "B",
    sortOrder: 4,
    subscribed: true,
    subscriptionSource: "product",
    displayColor: "#3157a4",
    colorSource: "product",
    adminDefaultColor: "#3157a4",
    driveSubscribed: null,
    driveColorOverride: null,
    scoreSubscriptionOverride: null,
    canEdit: true,
  },
];

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  await localDatabase.open();
  await localDatabase.annotations.clear();
  await activateAuthenticatedLocalOwner("user-1");
  editor = new AnnotationEditor(workspace);
  editor.begin();
});

describe("AnnotationOverlay", () => {
  it("focuses new text even while a previous annotation is being saved", () => {
    vi.spyOn(editor, "getSnapshot").mockReturnValue("saving");
    renderOverlay([], "text");
    const overlay = screen.getByLabelText("第 1 页笔记层");
    mockBounds(overlay);
    fireEvent.pointerDown(overlay, { pointerId: 1, pointerType: "touch", clientX: 20, clientY: 30 });
    fireEvent.pointerUp(overlay, { pointerId: 1, pointerType: "touch", clientX: 20, clientY: 30 });
    expect(screen.getByLabelText("笔记文本")).toHaveFocus();
    expect(screen.getByLabelText("笔记文本")).not.toHaveAttribute("placeholder");
    expect(screen.getByLabelText("笔记文本")).not.toBeDisabled();
  });

  it.each(["ink", "highlighter"] as const)("finishes an active %s stroke before closing without pointerup", async tool => {
    renderOverlay([], tool);
    const overlay = screen.getByLabelText("第 1 页笔记层"); mockBounds(overlay);
    fireEvent.pointerDown(overlay, { pointerId: 41, clientX: 20, clientY: 30 });
    fireEvent.pointerMove(overlay, { pointerId: 41, clientX: 80, clientY: 30 });
    await act(async () => {
      expect(await editor.finish()).toBe("local-saved");
    });
    const note = (await localDatabase.annotations.toArray())[0]!;
    expect(note.payload?.kind).toBe("ink");
    if (note.payload?.kind !== "ink") return;
    expect(note.payload.points.at(-1)).toMatchObject({ x: .8, y: .3 });
  });

  it.each(["rectangle", "ellipse", "highlighter"] as const)("persists %s geometry and color with undo and redo", async tool => {
    const view = renderOverlay([], tool);
    const overlay = screen.getByLabelText("第 1 页笔记层"); mockBounds(overlay);
    fireEvent.pointerDown(overlay, { pointerId: 41, clientX: 20, clientY: 30 });
    fireEvent.pointerMove(overlay, { pointerId: 41, clientX: 70, clientY: 80 });
    fireEvent.pointerUp(overlay, { pointerId: 41, clientX: 70, clientY: 80 });
    await waitFor(async () => expect(await localDatabase.annotations.count()).toBe(1));
    await waitFor(() => expect(editor.getSnapshot()).toBe("idle"));
    const note = (await localDatabase.annotations.toArray())[0]!;
    expect(note.payload).toMatchObject(tool === "highlighter"
      ? { kind: "ink", brush: "highlighter", nib: "chisel", pressureMode: "uniform", color: "#facc15", opacity: 0.3, strokeWidth: 0.018, points: [{ x: .2, y: .3 }, { x: .2, y: .3 }, { x: .7, y: .8 }] }
      : { kind: "shape", shape: tool, color: "#dc2626", x: .2, y: .3, width: expect.closeTo(.5), height: expect.closeTo(.5) });
    await act(async () => { await editor.undo(activeLayerId); });
    expect(await localDatabase.annotations.count()).toBe(0);
    await act(async () => { await editor.redo(activeLayerId); });
    expect((await localDatabase.annotations.toArray())[0]!.payload).toEqual(note.payload);
    const personal = { ...layers[0]!, kind: "personal" as const, sharedSlot: null };
    view.rerender(<AnnotationOverlay editor={editor} pageNumber={1} layers={[personal]} annotations={[note]} editing tool={tool} toolColor="#0000ff" activeLayerId={activeLayerId} />);
    expect(overlay.querySelector(tool === "rectangle" ? "rect" : tool === "ellipse" ? "ellipse" : "path[data-ink-stroke]")).toHaveAttribute(tool === "highlighter" ? "fill" : "stroke", tool === "highlighter" ? "#facc15" : "#dc2626");
  });

  it("stops new edits after layer deletion while saving an open composer to the original layer", async () => {
    const view = renderOverlay([], "text");
    const overlay = screen.getByLabelText("第 1 页笔记层");
    openNewText(overlay);
    fireEvent.change(screen.getByLabelText("笔记文本"), { target: { value: "尚未完成的输入" } });
    view.rerender(<AnnotationOverlay editor={editor} pageNumber={1} layers={[layers[1]!]} annotations={[]} editing tool="text" activeLayerId={activeLayerId} />);
    expect(screen.getByText("此层已停止编辑")).toBeVisible();
    expect(screen.getByLabelText("笔记文本")).toHaveValue("尚未完成的输入");
    fireEvent.submit(screen.getByRole("form", { name: "文字输入" }));
    await waitFor(async () => expect(await localDatabase.annotations.toArray()).toEqual([expect.objectContaining({ layerId: activeLayerId, state: "draft", payload: expect.objectContaining({ text: "尚未完成的输入" }) })]));
    await waitFor(() => expect(screen.queryByRole("form", { name: "文字输入" })).not.toBeInTheDocument());
    openNewText(overlay);
    expect(screen.queryByRole("form", { name: "文字输入" })).not.toBeInTheDocument();
  });

  it("keeps the centered composer open across blur until cancel", async () => {
    const visualViewport = installVisualViewport();
    const interactions: AnnotationOverlayInteraction[] = [];
    let handlingPointerUp = false;
    const focusStates: Array<{
      active: boolean;
      hidden: string | null;
      tabIndex: number;
      sameEventStack: boolean;
      preventScroll: boolean;
    }> = [];
    vi.spyOn(HTMLTextAreaElement.prototype, "focus").mockImplementation(function (
      this: HTMLTextAreaElement,
      options?: FocusOptions,
    ) {
      const composer = this.closest("form");
      focusStates.push({
        active: composer?.hasAttribute("data-active") ?? false,
        hidden: composer?.getAttribute("aria-hidden") ?? null,
        tabIndex: this.tabIndex,
        sameEventStack: handlingPointerUp,
        preventScroll: options?.preventScroll ?? false,
      });
      HTMLElement.prototype.focus.call(this);
    });
    renderOverlay([], "text", (interaction) => interactions.push(interaction));
    const overlay = screen.getByLabelText("第 1 页笔记层");
    mockBounds(overlay);
    expect(document.querySelector(".annotation-text-composer textarea")).toBeNull();
    overlay.addEventListener("pointerup", () => {
      handlingPointerUp = true;
    });

    fireEvent.pointerDown(overlay, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 20,
      clientY: 30,
    });
    expect(document.querySelector(".annotation-text-composer")).not.toHaveAttribute(
      "data-active",
    );
    expect(focusStates).toHaveLength(0);
    fireEvent.pointerUp(overlay, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 20,
      clientY: 30,
    });
    handlingPointerUp = false;
    const composer = screen.getByRole("form", { name: "文字输入" });
    const input = screen.getByLabelText("笔记文本") as HTMLTextAreaElement;
    const stableInput = input;
    expect(input).toHaveFocus();
    expect(focusStates[0]).toEqual({
      active: true,
      hidden: null,
      tabIndex: 0,
      sameEventStack: true,
      preventScroll: false,
    });
    expect(interactions).toEqual(["composing-text"]);
    expect(input).toHaveStyle({ color: "rgb(161, 38, 82)" });
    const fontScale = screen.getByRole("slider", { name: "字号" });
    expect(fontScale).toHaveValue("0.024");
    const fontValue = composer.querySelector(".annotation-font-scale__value");
    expect(fontValue).not.toHaveAttribute("data-visible");
    fireEvent.change(input, { target: { value: "保持选择范围" } });
    expect(screen.getByLabelText("笔记文本")).toBe(stableInput);
    input.setSelectionRange(2, 6, "forward");
    fireEvent.pointerDown(fontScale);
    fontScale.focus();
    expect(fontValue).toHaveAttribute("data-visible");
    fireEvent.change(fontScale, { target: { value: "0.04" } });
    expect(fontScale).toHaveValue("0.04");
    expect(screen.getByLabelText("笔记文本")).toBe(stableInput);
    expect(input).toHaveValue("保持选择范围");
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(6);
    fireEvent.pointerUp(fontScale);
    expect(fontValue).not.toHaveAttribute("data-visible");
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(6);
    expect(input.selectionDirection).toBe("forward");
    expect(input).toHaveValue("保持选择范围");
    expect(screen.getByLabelText("笔记文本")).toBe(stableInput);
    expect(focusStates.at(-1)?.preventScroll).toBe(true);

    act(() => {
      visualViewport.dispatchEvent(new Event("resize"));
    });
    expect(screen.getByLabelText("笔记文本")).toBe(stableInput);

    fireEvent.change(input, { target: { value: "尚未确认" } });
    fireEvent.blur(input);
    expect(screen.getByLabelText("笔记文本")).toHaveValue("尚未确认");
    expect(await localDatabase.annotations.count()).toBe(0);

    fireEvent.click(within(composer).getByRole("button", { name: "取消" }));
    expect(interactions).toEqual(["composing-text", "idle"]);
    expect(screen.queryByRole("form", { name: "文字输入" })).not.toBeInTheDocument();
    expect(await localDatabase.annotations.count()).toBe(0);
  });

  it("does not open text composition for a drag or cancelled placement", () => {
    const focus = vi.spyOn(HTMLTextAreaElement.prototype, "focus");
    renderOverlay([], "text");
    const overlay = screen.getByLabelText("第 1 页笔记层");
    mockBounds(overlay);

    fireEvent.pointerDown(overlay, {
      pointerId: 8,
      pointerType: "touch",
      clientX: 20,
      clientY: 30,
    });
    fireEvent.pointerMove(overlay, {
      pointerId: 8,
      pointerType: "touch",
      clientX: 40,
      clientY: 30,
    });
    fireEvent.pointerUp(overlay, {
      pointerId: 8,
      pointerType: "touch",
      clientX: 40,
      clientY: 30,
    });
    fireEvent.pointerDown(overlay, {
      pointerId: 9,
      pointerType: "touch",
      clientX: 20,
      clientY: 30,
    });
    fireEvent.pointerCancel(overlay, {
      pointerId: 9,
      pointerType: "touch",
      clientX: 20,
      clientY: 30,
    });

    expect(document.querySelector(".annotation-text-composer")).not.toHaveAttribute(
      "data-active",
    );
    expect(focus).not.toHaveBeenCalled();
  });

  it("mounts and autofocuses a fresh textarea during Pencil pointerdown", () => {
    let handlingPointerDown = false;
    const focusStates: Array<{
      active: boolean;
      sameEventStack: boolean;
    }> = [];
    vi.spyOn(HTMLTextAreaElement.prototype, "focus").mockImplementation(function (
      this: HTMLTextAreaElement,
    ) {
      focusStates.push({
        active: this.closest("form")?.hasAttribute("data-active") ?? false,
        sameEventStack: handlingPointerDown,
      });
      HTMLElement.prototype.focus.call(this);
    });
    renderOverlay([], "text");
    const overlay = screen.getByLabelText("第 1 页笔记层");
    mockBounds(overlay);
    expect(document.querySelector(".annotation-text-composer textarea")).toBeNull();
    overlay.addEventListener("pointerdown", () => {
      handlingPointerDown = true;
    });

    fireEvent.pointerDown(overlay, {
      pointerId: 7,
      pointerType: "pen",
      clientX: 20,
      clientY: 30,
    });
    handlingPointerDown = false;

    const input = screen.getByLabelText("笔记文本");
    expect(input).toHaveFocus();
    expect(focusStates).toEqual([{ active: true, sameEventStack: true }]);
  });

  it("closes the Pencil composer when placement becomes a drag or is cancelled", () => {
    renderOverlay([], "text");
    const overlay = screen.getByLabelText("第 1 页笔记层");
    mockBounds(overlay);

    fireEvent.pointerDown(overlay, {
      pointerId: 7,
      pointerType: "pen",
      clientX: 20,
      clientY: 30,
    });
    expect(screen.getByRole("form", { name: "文字输入" })).toBeInTheDocument();
    fireEvent.pointerMove(overlay, {
      pointerId: 7,
      pointerType: "pen",
      clientX: 40,
      clientY: 30,
    });
    fireEvent.pointerUp(overlay, {
      pointerId: 7,
      pointerType: "pen",
      clientX: 40,
      clientY: 30,
    });
    expect(screen.queryByRole("form", { name: "文字输入" })).not.toBeInTheDocument();
    expect(document.querySelector(".annotation-text-composer textarea")).toBeNull();

    fireEvent.pointerDown(overlay, {
      pointerId: 8,
      pointerType: "pen",
      clientX: 20,
      clientY: 30,
    });
    expect(screen.getByRole("form", { name: "文字输入" })).toBeInTheDocument();
    fireEvent.pointerCancel(overlay, {
      pointerId: 8,
      pointerType: "pen",
      clientX: 20,
      clientY: 30,
    });
    expect(screen.queryByRole("form", { name: "文字输入" })).not.toBeInTheDocument();
    expect(document.querySelector(".annotation-text-composer textarea")).toBeNull();
  });

  it("keeps Apple Pencil activation on the same textarea without simulating system UI", () => {
    const focus = vi.spyOn(HTMLTextAreaElement.prototype, "focus");
    renderOverlay([], "text");
    const overlay = screen.getByLabelText("第 1 页笔记层");
    mockBounds(overlay);
    expect(document.querySelector(".annotation-text-composer textarea")).toBeNull();

    fireEvent.pointerDown(overlay, {
      pointerId: 7,
      pointerType: "pen",
      clientX: 20,
      clientY: 30,
    });
    const stableInput = screen.getByLabelText("笔记文本");
    fireEvent.pointerUp(overlay, {
      pointerId: 7,
      pointerType: "pen",
      clientX: 20,
      clientY: 30,
    });

    expect(screen.getByLabelText("笔记文本")).toBe(stableInput);
    expect(focus).toHaveBeenCalledOnce();
  });

  it("saves multiline text, its original page anchor and normalized font scale only on complete", async () => {
    renderOverlay([], "text");
    const overlay = screen.getByLabelText("第 1 页笔记层");
    mockBounds(overlay);
    openNewText(overlay);
    const composer = screen.getByRole("form", { name: "文字输入" });
    fireEvent.change(screen.getByLabelText("笔记文本"), {
      target: { value: "第一行\n第二行" },
    });
    fireEvent.change(screen.getByRole("slider", { name: "字号" }), {
      target: { value: "0.04" },
    });
    fireEvent.click(within(composer).getByRole("button", { name: "完成" }));

    await waitFor(async () => {
      expect(await localDatabase.annotations.toCollection().first()).toMatchObject({
        state: "draft",
        payload: {
          kind: "text",
          x: 0.2,
          y: 0.3,
          fontScale: 0.04,
          text: "第一行\n第二行",
        },
      });
    });
  });

  it("completes text from the empty backdrop without completing from editor controls", async () => {
    renderOverlay([], "text");
    const overlay = screen.getByLabelText("第 1 页笔记层");
    mockBounds(overlay);
    openNewText(overlay);
    const composer = screen.getByRole("form", { name: "文字输入" });
    fireEvent.change(screen.getByLabelText("笔记文本"), {
      target: { value: "外围完成" },
    });

    fireEvent.click(screen.getByRole("slider", { name: "字号" }));
    expect(screen.getByRole("form", { name: "文字输入" })).toBeInTheDocument();
    expect(await localDatabase.annotations.count()).toBe(0);

    fireEvent.pointerDown(composer);
    fireEvent.pointerCancel(composer);
    expect(screen.getByRole("form", { name: "文字输入" })).toBeInTheDocument();
    expect(await localDatabase.annotations.count()).toBe(0);

    const persist = vi.spyOn(editor, "persist");
    // The opening gesture's click and a double-click continuation must not commit.
    fireEvent.click(composer, { detail: 1 });
    expect(persist).not.toHaveBeenCalled();
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("form", { name: "文字输入" })).toBeInTheDocument();
    fireEvent.pointerDown(composer, { pointerId: 2, detail: 2 });
    fireEvent.pointerUp(composer, { pointerId: 2, detail: 2 });
    fireEvent.click(composer, { detail: 2 });
    expect(screen.getByRole("form", { name: "文字输入" })).toBeInTheDocument();

    fireEvent.pointerDown(composer, { pointerId: 3 });
    fireEvent.pointerUp(composer, { pointerId: 3 });
    fireEvent.click(composer, { detail: 1 });
    await waitFor(() => expect(screen.queryByRole("form", { name: "文字输入" })).not.toBeInTheDocument());
    await waitFor(async () => {
      expect(await localDatabase.annotations.toCollection().first()).toMatchObject({
        payload: { kind: "text", text: "外围完成" },
      });
    });
  });

  it("retains unwritten text and retries after local storage fails", async () => {
    renderOverlay([], "text");
    const overlay = screen.getByLabelText("第 1 页笔记层");
    mockBounds(overlay);
    openNewText(overlay);
    fireEvent.change(screen.getByLabelText("笔记文本"), { target: { value: "尚未写入的草稿" } });
    let rejectWrite!: (reason: Error) => void;
    const write = vi.spyOn(localDatabase.annotations, "put").mockImplementation(() => new Dexie.Promise((_resolve, reject) => { rejectWrite = reject; }));
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(screen.getByLabelText("笔记文本")).toHaveAttribute("readonly"));
    expect(screen.getByRole("slider", { name: "字号" })).toBeDisabled();
    await waitFor(() => expect(write).toHaveBeenCalled());
    rejectWrite(new DOMException("full", "QuotaExceededError"));
    expect(await screen.findByText("本机保存失败")).toBeInTheDocument();
    expect(screen.getByLabelText("笔记文本")).toHaveValue("尚未写入的草稿");
    expect(await localDatabase.annotations.count()).toBe(0);
    write.mockRestore();
    fireEvent.click(screen.getByRole("button", { name: "重试本机保存" }));
    await waitFor(() => expect(screen.queryByText("本机保存失败")).not.toBeInTheDocument());
    expect(await localDatabase.annotations.toCollection().first()).toMatchObject({ state: "draft", payload: { text: "尚未写入的草稿" } });
  });

  it("discards failed text intent when the user cancels the composer", async () => {
    // Publishing the editor error can precede the composer's async finally.
    // Hold that boundary explicitly instead of depending on CI scheduling.
    const persist = editor.persist.bind(editor);
    let release!: () => void;
    const completion = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(editor, "persist").mockImplementation(async (...args) => {
      const result = await persist(...args);
      await completion;
      return result;
    });
    renderOverlay([], "text");
    const overlay = screen.getByLabelText("第 1 页笔记层");
    mockBounds(overlay);
    openNewText(overlay);
    fireEvent.change(screen.getByLabelText("笔记文本"), { target: { value: "取消这次修改" } });
    const write = vi.spyOn(localDatabase.annotations, "put").mockRejectedValue(new DOMException("full", "QuotaExceededError"));
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    await screen.findByText("本机保存失败");
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    release();
    await waitFor(() => expect(screen.getByRole("button", { name: "取消" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByText("本机保存失败")).not.toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "文字输入" })).not.toBeInTheDocument();
    write.mockRestore();
    await act(async () => { await editor.retry(); });
    expect(await localDatabase.annotations.count()).toBe(0);
  });

  it("treats complete on empty new text as no-op and empty existing text as delete", async () => {
    const newView = renderOverlay([], "text");
    const overlay = screen.getByLabelText("第 1 页笔记层");
    mockBounds(overlay);
    openNewText(overlay);
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    expect(await localDatabase.annotations.count()).toBe(0);
    newView.unmount();

    const text = annotation("text-1", activeLayerId, textPayload("原文"));
    await localDatabase.annotations.put(text);
    renderOverlay([text], "text");
    openExistingText("原文");
    fireEvent.change(screen.getByLabelText("笔记文本"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(async () => {
      expect(await localDatabase.annotations.get(text.key)).toMatchObject({
        deleted: true,
        payload: null,
      });
    });
  });

  it("cancels an existing text edit without changing the object", async () => {
    const text = annotation("text-1", activeLayerId, textPayload("原文"));
    await localDatabase.annotations.put(text);
    renderOverlay([text], "text");
    openExistingText("原文");
    fireEvent.change(screen.getByLabelText("笔记文本"), { target: { value: "误改" } });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(await localDatabase.annotations.get(text.key)).toMatchObject({
      state: "synced",
      payload: { text: "原文" },
    });
  });

  it.each(["text", "rectangle", "ellipse"] as const)("moves text with the %s tool and records one undoable final change", async tool => {
    const text = annotation("text-1", activeLayerId, textPayload("跟随拖动"));
    await localDatabase.annotations.put(text);
    renderOverlay([text], tool);
    const button = screen.getByRole("button", { name: "跟随拖动" });
    mockBounds(button.parentElement!);
    mockTextBounds(button);

    fireEvent.pointerDown(button, { pointerId: 3, clientX: 20, clientY: 30 });
    fireEvent.pointerMove(button, { pointerId: 3, clientX: 60, clientY: 70 });
    expect(Number.parseFloat(button.style.left)).toBeCloseTo(60);
    expect(Number.parseFloat(button.style.top)).toBeCloseTo(70);
    fireEvent.pointerUp(button, { pointerId: 3, clientX: 60, clientY: 70 });
    expect(Number.parseFloat(button.style.left)).toBeCloseTo(60);
    expect(Number.parseFloat(button.style.top)).toBeCloseTo(70);

    await waitFor(async () => {
      const stored = await localDatabase.annotations.get(text.key);
      expect(stored).toMatchObject({ state: "draft" });
      expect(stored?.payload?.kind).toBe("text");
      if (stored?.payload?.kind !== "text") return;
      expect(stored.payload.x).toBeCloseTo(0.6);
      expect(stored.payload.y).toBeCloseTo(0.7);
    });
    expect(await editor.undo(activeLayerId)).toBe(true);
    expect(await editor.undo(activeLayerId)).toBe(false);
  });

  it("keeps consecutive released transforms through a failed write, retry, projection and undo", async () => {
    const text = annotation("text-1", activeLayerId, textPayload("连续拖动"));
    await localDatabase.annotations.put(text);
    const view = renderOverlay([text], "text");
    const button = screen.getByRole("button", { name: "连续拖动" });
    mockBounds(button.parentElement!); mockTextBounds(button);
    const write = vi.spyOn(localDatabase.annotations, "put").mockRejectedValueOnce(new Error("storage failed"));
    fireEvent.pointerDown(button, { pointerId: 3, clientX: 20, clientY: 30 });
    fireEvent.pointerMove(button, { pointerId: 3, clientX: 40, clientY: 50 });
    fireEvent.pointerUp(button, { pointerId: 3, clientX: 40, clientY: 50 });
    await waitFor(() => expect(editor.getSnapshot()).toBe("failed"));
    expect(Number.parseFloat(button.style.left)).toBeCloseTo(40);
    write.mockRestore();
    await act(async () => { expect(await editor.retry()).toBe(true); });
    expect(Number.parseFloat(button.style.left)).toBeCloseTo(40);
    // The next gesture starts before the asynchronous local projection arrives.
    fireEvent.pointerDown(button, { pointerId: 4, clientX: 40, clientY: 50 });
    fireEvent.pointerMove(button, { pointerId: 4, clientX: 60, clientY: 70 });
    fireEvent.pointerUp(button, { pointerId: 4, clientX: 60, clientY: 70 });
    expect(Number.parseFloat(button.style.left)).toBeCloseTo(60);
    await waitFor(() => expect(editor.getSnapshot()).toBe("idle"));
    const project = async () => {
      const saved = (await localDatabase.annotations.get(text.key))!;
      view.rerender(<AnnotationOverlay editor={editor} pageNumber={1} layers={layers} annotations={[saved]} editing tool="text" activeLayerId={activeLayerId} />);
    };
    await project();
    expect(Number.parseFloat(button.style.left)).toBeCloseTo(60);
    await act(async () => { expect(await editor.undo(activeLayerId)).toBe(true); });
    await project();
    expect(Number.parseFloat(button.style.left)).toBeCloseTo(40);
    await act(async () => { expect(await editor.undo(activeLayerId)).toBe(true); });
    await project();
    expect(Number.parseFloat(button.style.left)).toBeCloseTo(20);
    expect(await editor.undo(activeLayerId)).toBe(false);
  });

  it("retires a discarded failed drag preview when canceling its text composer", async () => {
    const text = annotation("text-1", activeLayerId, textPayload("取消失败拖动"));
    await localDatabase.annotations.put(text);
    renderOverlay([text], "text");
    const button = screen.getByRole("button", { name: "取消失败拖动" });
    mockBounds(button.parentElement!); mockTextBounds(button);
    const write = vi.spyOn(localDatabase.annotations, "put").mockRejectedValueOnce(new Error("storage failed"));
    fireEvent.pointerDown(button, { pointerId: 3, clientX: 20, clientY: 30 });
    fireEvent.pointerMove(button, { pointerId: 3, clientX: 40, clientY: 50 });
    fireEvent.pointerUp(button, { pointerId: 3, clientX: 40, clientY: 50 });
    await waitFor(() => expect(editor.getSnapshot()).toBe("failed"));
    expect(Number.parseFloat(button.style.left)).toBeCloseTo(40);
    write.mockRestore();
    openExistingText("取消失败拖动");
    fireEvent.keyDown(screen.getByLabelText("笔记文本"), { key: "Escape" });
    expect(screen.queryByLabelText("笔记文本")).not.toBeInTheDocument();
    expect(editor.getSnapshot()).toBe("idle");
    expect(Number.parseFloat(button.style.left)).toBeCloseTo(20);
    expect((await localDatabase.annotations.get(text.key))?.payload).toEqual(text.payload);
    await act(async () => { expect(await editor.finish()).toBe("local-saved"); });
    expect((await localDatabase.annotations.get(text.key))?.payload).toEqual(text.payload);
  });

  it("shows undo even if the local query skips the released drag projection", async () => {
    const text = annotation("text-1", activeLayerId, textPayload("快速撤销"));
    await localDatabase.annotations.put(text);
    const view = renderOverlay([text], "text");
    const button = screen.getByRole("button", { name: "快速撤销" });
    mockBounds(button.parentElement!); mockTextBounds(button);
    fireEvent.pointerDown(button, { pointerId: 3, clientX: 20, clientY: 30 });
    fireEvent.pointerMove(button, { pointerId: 3, clientX: 60, clientY: 70 });
    fireEvent.pointerUp(button, { pointerId: 3, clientX: 60, clientY: 70 });
    await waitFor(() => expect(editor.getSnapshot()).toBe("idle"));
    expect(Number.parseFloat(button.style.left)).toBeCloseTo(60);
    await act(async () => { expect(await editor.undo(activeLayerId)).toBe(true); });
    const saved = (await localDatabase.annotations.get(text.key))!;
    view.rerender(<AnnotationOverlay editor={editor} pageNumber={1} layers={layers} annotations={[saved]} editing tool="text" activeLayerId={activeLayerId} />);
    expect(Number.parseFloat(button.style.left)).toBeCloseTo(20);
  });

  it("cancels an unfinished stroke on tool change without remounting saved ink", async () => {
    const saved = annotation("ink-saved", activeLayerId, { kind: "ink", pageNumber: 1, brush: "highlighter", nib: "chisel", pressureMode: "uniform", strokeWidth: .02, points: [{ x: .1, y: .1 }, { x: .2, y: .2 }] });
    const view = renderOverlay([saved], "highlighter");
    const overlay = screen.getByLabelText("第 1 页笔记层"); mockBounds(overlay);
    const path = overlay.querySelector("path[data-ink-stroke]");
    fireEvent.pointerDown(overlay, { pointerId: 4, clientX: 30, clientY: 40 });
    fireEvent.pointerMove(overlay, { pointerId: 4, clientX: 50, clientY: 60 });
    view.rerender(<AnnotationOverlay editor={editor} pageNumber={1} layers={layers} annotations={[saved]} editing tool="eraser" activeLayerId={activeLayerId} />);
    expect(overlay.querySelector("path[data-ink-stroke]")).toBe(path);
    await waitFor(async () => expect((await localDatabase.annotations.toArray()).filter(note => !note.deleted)).toHaveLength(0));
    await act(async () => { await editor.finish(); });
    expect((await localDatabase.annotations.toArray()).filter(note => !note.deleted)).toHaveLength(0);
  });

  it.each(["text", "rectangle", "ellipse"] as const)("moves and trash-deletes shapes with the %s tool", async tool => {
    const shape = annotation("shape-1", activeLayerId, { kind: "shape", shape: "ellipse", pageNumber: 1, x: .2, y: .3, width: .2, height: .1, strokeWidth: .003 });
    await localDatabase.annotations.put(shape);
    const view = renderOverlay([shape], tool);
    const button = screen.getByRole("button", { name: "椭圆笔记" });
    mockBounds(button.parentElement!);
    fireEvent.pointerDown(button, { pointerId: 3, clientX: 20, clientY: 30 });
    fireEvent.pointerMove(button, { pointerId: 3, clientX: 50, clientY: 60 });
    fireEvent.pointerUp(button, { pointerId: 3, clientX: 50, clientY: 60 });
    await waitFor(async () => expect((await localDatabase.annotations.get(shape.key))?.payload).toMatchObject({ x: .5, y: .6, width: .2, height: .1 }));
    expect(screen.queryByLabelText("笔记文本")).toBeNull();
    await act(async () => { await editor.undo(activeLayerId); });
    expect((await localDatabase.annotations.get(shape.key))?.payload).toEqual(shape.payload);
    view.rerender(<AnnotationOverlay editor={editor} pageNumber={1} layers={layers} annotations={[shape]} editing tool={tool} activeLayerId={activeLayerId} />);
    const trash = document.querySelector<HTMLElement>(".annotation-delete-zone")!;
    vi.spyOn(trash, "getBoundingClientRect").mockReturnValue({ left: 0, top: 80, width: 100, height: 100 } as DOMRect);
    fireEvent.pointerDown(button, { pointerId: 4, clientX: 20, clientY: 30 });
    fireEvent.pointerMove(button, { pointerId: 4, clientX: 50, clientY: 130 });
    fireEvent.pointerUp(button, { pointerId: 4, clientX: 50, clientY: 130 });
    await waitFor(async () => expect(await localDatabase.annotations.get(shape.key)).toMatchObject({ deleted: true }));
  });

  it("the eraser leaves shapes intact", async () => {
    const shape = annotation("shape-1", activeLayerId, { kind: "shape", shape: "rectangle", pageNumber: 1, x: .2, y: .3, width: .2, height: .1, strokeWidth: .003 });
    await localDatabase.annotations.put(shape);
    renderOverlay([shape], "eraser");
    const overlay = screen.getByLabelText("第 1 页笔记层"); mockBounds(overlay);
    fireEvent.pointerDown(overlay, { pointerId: 1, clientX: 20, clientY: 30 });
    fireEvent.pointerUp(overlay, { pointerId: 1, clientX: 20, clientY: 30 });
    await editor.finish();
    expect((await localDatabase.annotations.get(shape.key))?.payload).toEqual(shape.payload);
  });

  it.each(["text", "select"] as const)("adds a second pointer to scale and move text in %s mode before one final save", async tool => {
    const text = annotation("text-1", activeLayerId, textPayload("双指缩放"));
    await localDatabase.annotations.put(text);
    renderOverlay([text], tool);
    const button = screen.getByRole("button", { name: "双指缩放" });
    const overlay = screen.getByLabelText("第 1 页笔记层");
    mockBounds(button.parentElement!);
    mockTextBounds(button);

    fireEvent.pointerDown(button, { pointerId: 1, clientX: 20, clientY: 30 });
    fireEvent.pointerDown(overlay, { pointerId: 2, clientX: 40, clientY: 30 });
    fireEvent.pointerMove(overlay, { pointerId: 2, clientX: 60, clientY: 30 });
    expect(Number.parseFloat(button.style.fontSize)).toBeCloseTo(4.8);
    fireEvent.pointerUp(overlay, { pointerId: 2, clientX: 60, clientY: 30 });
    fireEvent.pointerUp(button, { pointerId: 1, clientX: 20, clientY: 30 });

    await waitFor(async () => {
      const stored = await localDatabase.annotations.get(text.key);
      expect(stored?.payload?.kind).toBe("text");
      if (stored?.payload?.kind !== "text") return;
      expect(stored.payload.fontScale).toBeCloseTo(0.048);
      expect(stored.payload.x).toBeCloseTo(0.3);
    });
  });

  it("clamps a pinched text using its new rendered size before release", async () => {
    const text = annotation("text-1", activeLayerId, textPayload("边缘缩放", 0.9, 0.3));
    await localDatabase.annotations.put(text);
    renderOverlay([text], "text");
    const button = screen.getByRole("button", { name: "边缘缩放" });
    const overlay = screen.getByLabelText("第 1 页笔记层");
    mockBounds(button.parentElement!);
    mockDynamicTextBounds(button);

    fireEvent.pointerDown(button, { pointerId: 1, clientX: 90, clientY: 30 });
    fireEvent.pointerDown(overlay, { pointerId: 2, clientX: 70, clientY: 30 });
    fireEvent.pointerMove(overlay, { pointerId: 2, clientX: 50, clientY: 30 });
    fireEvent.pointerUp(overlay, { pointerId: 2, clientX: 50, clientY: 30 });
    fireEvent.pointerUp(button, { pointerId: 1, clientX: 90, clientY: 30 });

    await waitFor(async () => {
      const stored = await localDatabase.annotations.get(text.key);
      expect(stored?.payload?.kind).toBe("text");
      if (stored?.payload?.kind !== "text") return;
      expect(stored.payload.fontScale).toBeCloseTo(0.048);
      expect(stored.payload.x).toBeCloseTo(0.7);
    });
  });

  it("deletes only when a dragged text is released in the bottom target", async () => {
    const text = annotation("text-1", activeLayerId, textPayload("拖动删除"));
    const interactions: AnnotationOverlayInteraction[] = [];
    await localDatabase.annotations.put(text);
    renderOverlay([text], "text", (interaction) => interactions.push(interaction));
    const button = screen.getByRole("button", { name: "拖动删除" });
    mockBounds(button.parentElement!);
    mockTextBounds(button);
    const deleteTarget = document.querySelector(".annotation-delete-zone");
    expect(deleteTarget).not.toBeNull();
    mockRect(deleteTarget!, { left: 472, top: 676, width: 80, height: 80 });

    fireEvent.pointerDown(button, { pointerId: 1, clientX: 20, clientY: 30 });
    fireEvent.pointerMove(button, { pointerId: 1, clientX: 20, clientY: 716 });
    expect(interactions).toEqual(["transforming-object"]);
    expect(screen.getByRole("status", { name: "拖到这里删除" })).not.toHaveAttribute(
      "data-active",
    );
    fireEvent.pointerMove(button, { pointerId: 1, clientX: 512, clientY: 716 });
    expect(screen.getByRole("status", { name: "拖到这里删除" })).toHaveAttribute(
      "data-active",
    );
    fireEvent.pointerUp(button, { pointerId: 1, clientX: 512, clientY: 716 });

    await waitFor(async () => {
      expect(await localDatabase.annotations.get(text.key)).toMatchObject({
        deleted: true,
        payload: null,
      });
    });
    expect(interactions).toEqual(["transforming-object", "idle"]);
  });

  it("restores text on pointer cancel", async () => {
    const text = annotation("text-1", activeLayerId, textPayload("原始文本"));
    await localDatabase.annotations.put(text);
    renderOverlay([text], "text");
    const button = screen.getByRole("button", { name: "原始文本" });
    mockBounds(button.parentElement!);
    mockTextBounds(button);
    fireEvent.pointerDown(button, { pointerId: 5, clientX: 20, clientY: 30 });
    fireEvent.pointerMove(button, { pointerId: 5, clientX: 70, clientY: 80 });
    fireEvent.pointerCancel(button, { pointerId: 5, clientX: 70, clientY: 80 });
    expect(Number.parseFloat(button.style.left)).toBeCloseTo(20);
    expect(await localDatabase.annotations.get(text.key)).toMatchObject({
      state: "synced",
      payload: { x: 0.2, y: 0.3 },
    });
  });

  it("erases nearby ink reliably but never text or another layer", async () => {
    const ink = annotation("ink-1", activeLayerId, {
      kind: "ink", brush: "pen", nib: "round", pressureMode: "uniform",
      pageNumber: 1,
      points: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }],
      strokeWidth: 0.003,
    });
    const text = annotation("text-1", activeLayerId, textPayload("不能擦除", 0.5, 0.5));
    const otherInk = annotation("ink-2", otherLayerId, {
      kind: "ink", brush: "pen", nib: "round", pressureMode: "uniform",
      pageNumber: 1,
      points: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }],
      strokeWidth: 0.003,
    });
    await localDatabase.annotations.bulkPut([ink, text, otherInk]);
    const { container } = renderOverlay([ink, text, otherInk], "eraser");
    const overlay = screen.getByLabelText("第 1 页笔记层");
    mockBounds(overlay);
    expect(container.querySelector("[data-eraser-hit-target]")).toHaveAttribute("stroke-width", "28");
    fireEvent.pointerDown(overlay, { pointerId: 4, clientX: 50, clientY: 62 });
    fireEvent.pointerMove(overlay, { pointerId: 4, clientX: 55, clientY: 61 });
    fireEvent.pointerUp(overlay, { pointerId: 4, clientX: 55, clientY: 61 });

    await waitFor(async () => {
      expect(await localDatabase.annotations.get(ink.key)).toMatchObject({ deleted: true });
    });
    expect(await localDatabase.annotations.get(text.key)).toMatchObject({ deleted: false });
    expect(await localDatabase.annotations.get(otherInk.key)).toMatchObject({ deleted: false });
  });

  it("shows only the active layer while editing even when it is unsubscribed", () => {
    const active = annotation("active", activeLayerId, textPayload("E 内容", 0.2, 0.2));
    const other = annotation("other", otherLayerId, textPayload("B 内容", 0.4, 0.4));
    const view = renderOverlay([active, other], "text");
    expect(screen.getByRole("button", { name: "E 内容" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "B 内容" })).not.toBeInTheDocument();

    view.rerender(
      <AnnotationOverlay
        editor={editor}
        pageNumber={1}
        layers={layers}
        annotations={[active, other]}
        editing={false}
        tool="text"
        activeLayerId={activeLayerId}
      />,
    );
    expect(screen.queryByRole("button", { name: "E 内容" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "B 内容" })).toBeInTheDocument();
  });
});

function renderOverlay(
  annotations: LocalAnnotationRecord[],
  tool: AnnotationTool,
  onInteractionChange?: (interaction: AnnotationOverlayInteraction) => void,
) {
  return render(
    <AnnotationOverlay
      editor={editor}
      pageNumber={1}
      layers={layers}
      annotations={annotations}
      editing
      tool={tool}
      activeLayerId={activeLayerId}
      onInteractionChange={onInteractionChange}
    />,
  );
}

function openExistingText(name: string) {
  const button = screen.getByRole("button", { name });
  fireEvent.pointerDown(button, { pointerId: 1, clientX: 20, clientY: 30 });
  fireEvent.pointerUp(button, { pointerId: 1, clientX: 20, clientY: 30 });
}

function openNewText(overlay: Element) {
  fireEvent.pointerDown(overlay, {
    pointerId: 1,
    pointerType: "touch",
    clientX: 20,
    clientY: 30,
  });
  fireEvent.pointerUp(overlay, {
    pointerId: 1,
    pointerType: "touch",
    clientX: 20,
    clientY: 30,
  });
}

function textPayload(text: string, x = 0.2, y = 0.3) {
  return { kind: "text" as const, pageNumber: 1, x, y, fontScale: 0.024, text };
}

function annotation(
  id: string,
  layerId: string,
  payload: NonNullable<LocalAnnotationRecord["payload"]>,
): LocalAnnotationRecord {
  return {
    key: annotationRecordKey(scopeKey, id),
    ...workspace,
    id,
    layerId,
    version: 1,
    baseVersion: 1,
    deleted: false,
    payload,
    state: "synced",
    lastOpId: null,
    syncErrorCode: null,
    updatedAt: 1,
  };
}

function mockBounds(element: Element) {
  mockRect(element, { left: 0, top: 0, width: 100, height: 100 });
}

function mockRect(
  element: Element,
  rect: { left: number; top: number; width: number; height: number },
) {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      x: rect.left,
      y: rect.top,
      top: rect.top,
      left: rect.left,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      width: rect.width,
      height: rect.height,
      toJSON: () => ({}),
    }),
  });
}

function mockTextBounds(element: Element) {
  mockRect(element, { left: 15, top: 25, width: 10, height: 10 });
}

function mockDynamicTextBounds(element: HTMLElement) {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => {
      const fontSize = Number.parseFloat(element.style.fontSize) || 2.4;
      const width = fontSize * 12.5;
      return {
        x: 90 - width / 2,
        y: 25,
        top: 25,
        left: 90 - width / 2,
        right: 90 + width / 2,
        bottom: 35,
        width,
        height: 10,
        toJSON: () => ({}),
      };
    },
  });
}

function installVisualViewport() {
  const viewport = new EventTarget() as EventTarget & Partial<VisualViewport>;
  Object.assign(viewport, {
    offsetTop: 0,
    offsetLeft: 0,
    width: 1024,
    height: 768,
  });
  vi.stubGlobal("visualViewport", viewport);
  return viewport;
}

afterEach(() => {
  editor.cancel();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["text", "ink"] as const)("blocks new %s input during completion and restores input after queue failure", async tool => {
  renderOverlay([], tool);
  const overlay = screen.getByLabelText("第 1 页笔记层"); mockBounds(overlay);
  let reject!: (reason: unknown) => void;
  const queue = vi.spyOn(annotationState, "queueScoreDrafts").mockReturnValueOnce(new Promise<number>((_, fail) => { reject = fail; }));
  let completion!: ReturnType<AnnotationEditor["finish"]>;
  act(() => { completion = editor.finish(); });
  await waitFor(() => expect(queue).toHaveBeenCalled());
  expect(editor.getSnapshot()).toBe("finishing");
  fireEvent.pointerDown(overlay, { pointerId: 42, clientX: 20, clientY: 30 });
  fireEvent.pointerMove(overlay, { pointerId: 42, clientX: 80, clientY: 30 });
  fireEvent.pointerUp(overlay, { pointerId: 42, clientX: 80, clientY: 30 });
  expect(screen.queryByLabelText("笔记文本")).not.toBeInTheDocument();
  expect(await localDatabase.annotations.count()).toBe(0);
  expect(screen.queryByText("此层已停止编辑")).not.toBeInTheDocument();
  await act(async () => { reject(new Error("storage unavailable")); expect(await completion).toBe("failed"); });
  fireEvent.pointerDown(overlay, { pointerId: 43, clientX: 20, clientY: 30 });
  fireEvent.pointerUp(overlay, { pointerId: 43, clientX: 20, clientY: 30 });
  if (tool === "text") expect(screen.getByLabelText("笔记文本")).not.toHaveAttribute("readonly");
  else await waitFor(async () => expect(await localDatabase.annotations.count()).toBe(1));
});
