import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AnnotationLayerSummary } from "../../shared/annotations";
import {
  annotationRecordKey,
  annotationScopeKey,
  localDatabase,
  type LocalAnnotationRecord,
} from "../platform/local-database";
import {
  beginAnnotationEditSession,
  endAnnotationEditSession,
  undoAnnotationEdit,
} from "./edit-history";
import { AnnotationOverlay, type AnnotationTool } from "./annotation-overlay";

const choirId = "choir-1";
const scoreId = "score-1";
const scopeKey = annotationScopeKey(choirId, scoreId);
const activeLayerId = "11111111-1111-4111-8111-111111111111";
const otherLayerId = "22222222-2222-4222-8222-222222222222";

const layers: AnnotationLayerSummary[] = [
  {
    id: activeLayerId,
    kind: "shared",
    defaultSlot: "G",
    name: "G",
    sortOrder: 0,
    defaultColor: "#a12652",
    colorOverride: null,
    visible: true,
    canEdit: true,
  },
  {
    id: otherLayerId,
    kind: "shared",
    defaultSlot: "B",
    name: "B",
    sortOrder: 4,
    defaultColor: "#3157a4",
    colorOverride: null,
    visible: true,
    canEdit: true,
  },
];

beforeEach(async () => {
  await localDatabase.open();
  await localDatabase.annotations.clear();
  beginAnnotationEditSession();
});

describe("AnnotationOverlay", () => {
  it("saves non-empty text at its original point when the score is tapped elsewhere", async () => {
    renderOverlay([], "text");
    const overlay = screen.getByLabelText("第 1 页批注层");
    mockBounds(overlay);

    fireEvent.pointerDown(overlay, { pointerId: 1, clientX: 20, clientY: 30 });
    expect(screen.getByLabelText("批注文本")).toBeInTheDocument();
    const input = screen.getByLabelText("批注文本");
    expect(input).toHaveFocus();
    expect(screen.queryByRole("button", { name: "保存" })).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "自动确认" } });

    fireEvent.pointerDown(overlay, { pointerId: 2, clientX: 80, clientY: 70 });
    expect(screen.queryByLabelText("批注文本")).not.toBeInTheDocument();
    await waitFor(async () => {
      const saved = await localDatabase.annotations.toCollection().first();
      expect(saved).toMatchObject({
        state: "draft",
        payload: { kind: "text", x: 0.2, y: 0.3, text: "自动确认" },
      });
    });
  });

  it("cancels empty new text and Escape without creating a draft", async () => {
    renderOverlay([], "text");
    const overlay = screen.getByLabelText("第 1 页批注层");
    mockBounds(overlay);

    fireEvent.pointerDown(overlay, { pointerId: 1, clientX: 20, clientY: 30 });
    fireEvent.pointerDown(overlay, { pointerId: 2, clientX: 80, clientY: 70 });
    expect(screen.queryByLabelText("批注文本")).not.toBeInTheDocument();
    expect(await localDatabase.annotations.count()).toBe(0);

    fireEvent.pointerDown(overlay, { pointerId: 3, clientX: 40, clientY: 50 });
    fireEvent.change(screen.getByLabelText("批注文本"), {
      target: { value: "应被取消" },
    });
    fireEvent.keyDown(screen.getByLabelText("批注文本"), { key: "Escape" });
    expect(screen.queryByLabelText("批注文本")).not.toBeInTheDocument();
    expect(await localDatabase.annotations.count()).toBe(0);
  });

  it("confirms non-empty text when focus moves to another control", async () => {
    renderOverlay([], "text");
    const overlay = screen.getByLabelText("第 1 页批注层");
    mockBounds(overlay);

    fireEvent.pointerDown(overlay, { pointerId: 1, clientX: 25, clientY: 35 });
    const input = screen.getByLabelText("批注文本");
    fireEvent.change(input, { target: { value: "失焦确认" } });
    fireEvent.blur(input);

    expect(screen.queryByLabelText("批注文本")).not.toBeInTheDocument();
    await waitFor(async () => {
      expect(await localDatabase.annotations.toCollection().first()).toMatchObject({
        payload: { kind: "text", x: 0.25, y: 0.35, text: "失焦确认" },
      });
    });
  });

  it("keeps an existing annotation when cleared and confirmed elsewhere", async () => {
    const text = annotation("text-1", activeLayerId, {
      kind: "text",
      pageNumber: 1,
      x: 0.2,
      y: 0.3,
      text: "保留原文",
    });
    await localDatabase.annotations.put(text);
    renderOverlay([text], "text");
    const button = screen.getByRole("button", { name: "保留原文" });

    fireEvent.pointerDown(button, { pointerId: 1, clientX: 20, clientY: 30 });
    fireEvent.pointerUp(button, { pointerId: 1, clientX: 20, clientY: 30 });
    fireEvent.change(screen.getByLabelText("批注文本"), { target: { value: "" } });
    const overlay = screen.getByLabelText("第 1 页批注层");
    mockBounds(overlay);
    fireEvent.pointerDown(overlay, { pointerId: 2, clientX: 80, clientY: 70 });

    expect(screen.queryByLabelText("批注文本")).not.toBeInTheDocument();
    expect(await localDatabase.annotations.get(text.key)).toMatchObject({
      state: "synced",
      payload: { text: "保留原文" },
    });
  });

  it("confirms text with Enter", async () => {
    renderOverlay([], "text");
    const overlay = screen.getByLabelText("第 1 页批注层");
    mockBounds(overlay);

    fireEvent.pointerDown(overlay, { pointerId: 1, clientX: 20, clientY: 30 });
    const input = screen.getByLabelText("批注文本");
    fireEvent.change(input, { target: { value: "回车确认" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await waitFor(async () => {
      expect(await localDatabase.annotations.toCollection().first()).toMatchObject({
        payload: { text: "回车确认" },
      });
    });
  });

  it("moves text with the pointer before saving its final position", async () => {
    const text = annotation("text-1", activeLayerId, {
      kind: "text",
      pageNumber: 1,
      x: 0.2,
      y: 0.3,
      text: "跟随拖动",
    });
    await localDatabase.annotations.put(text);
    renderOverlay([text], "text");
    const button = screen.getByRole("button", { name: "跟随拖动" });
    mockBounds(button.parentElement!);

    fireEvent.pointerDown(button, { pointerId: 3, clientX: 20, clientY: 30 });
    fireEvent.pointerMove(button, { pointerId: 3, clientX: 60, clientY: 70 });
    expect(Number.parseFloat(button.style.left)).toBeCloseTo(60);
    expect(Number.parseFloat(button.style.top)).toBeCloseTo(70);
    fireEvent.pointerUp(button, { pointerId: 3, clientX: 60, clientY: 70 });

    await waitFor(async () => {
      const stored = await localDatabase.annotations.get(text.key);
      expect(stored).toMatchObject({ state: "draft" });
      expect(stored?.payload?.kind).toBe("text");
      if (stored?.payload?.kind !== "text") return;
      expect(stored.payload.x).toBeCloseTo(0.6);
      expect(stored.payload.y).toBeCloseTo(0.7);
    });
    expect(await undoAnnotationEdit(choirId, scoreId, activeLayerId)).toBe(true);
    expect(await undoAnnotationEdit(choirId, scoreId, activeLayerId)).toBe(false);
  });

  it("restores text on pointer cancel and treats a tap as editing", async () => {
    const text = annotation("text-1", activeLayerId, {
      kind: "text",
      pageNumber: 1,
      x: 0.2,
      y: 0.3,
      text: "原始文本",
    });
    await localDatabase.annotations.put(text);
    renderOverlay([text], "text");
    const button = screen.getByRole("button", { name: "原始文本" });
    mockBounds(button.parentElement!);

    fireEvent.pointerDown(button, { pointerId: 5, clientX: 20, clientY: 30 });
    fireEvent.pointerMove(button, { pointerId: 5, clientX: 70, clientY: 80 });
    expect(Number.parseFloat(button.style.left)).toBeCloseTo(70);
    fireEvent.pointerCancel(button, { pointerId: 5, clientX: 70, clientY: 80 });
    expect(Number.parseFloat(button.style.left)).toBeCloseTo(20);
    expect(await localDatabase.annotations.get(text.key)).toMatchObject({
      state: "synced",
      payload: { x: 0.2, y: 0.3 },
    });

    fireEvent.pointerDown(button, { pointerId: 6, clientX: 20, clientY: 30 });
    fireEvent.pointerUp(button, { pointerId: 6, clientX: 20, clientY: 30 });
    expect(screen.getByLabelText("批注文本")).toHaveValue("原始文本");
    const overlay = screen.getByLabelText("第 1 页批注层");
    mockBounds(overlay);
    fireEvent.change(screen.getByLabelText("批注文本"), {
      target: { value: "修改后的文本" },
    });
    fireEvent.pointerDown(overlay, { pointerId: 7, clientX: 90, clientY: 90 });
    expect(screen.queryByLabelText("批注文本")).not.toBeInTheDocument();
    await waitFor(async () => {
      expect(await localDatabase.annotations.get(text.key)).toMatchObject({
        state: "draft",
        payload: { x: 0.2, y: 0.3, text: "修改后的文本" },
      });
    });
  });

  it("erases nearby ink reliably but never text or another layer", async () => {
    const ink = annotation("ink-1", activeLayerId, {
      kind: "ink",
      pageNumber: 1,
      points: [
        { x: 0.1, y: 0.5 },
        { x: 0.9, y: 0.5 },
      ],
      strokeWidth: 0.003,
    });
    const text = annotation("text-1", activeLayerId, {
      kind: "text",
      pageNumber: 1,
      x: 0.5,
      y: 0.5,
      text: "不能擦除",
    });
    const otherInk = annotation("ink-2", otherLayerId, {
      kind: "ink",
      pageNumber: 1,
      points: [
        { x: 0.1, y: 0.5 },
        { x: 0.9, y: 0.5 },
      ],
      strokeWidth: 0.003,
    });
    await localDatabase.annotations.bulkPut([ink, text, otherInk]);
    const { container } = renderOverlay([ink, text, otherInk], "eraser");
    const overlay = screen.getByLabelText("第 1 页批注层");
    mockBounds(overlay);
    expect(container.querySelector("[data-eraser-hit-target]")).toHaveAttribute(
      "stroke-width",
      "28",
    );

    fireEvent.pointerDown(overlay, {
      pointerId: 4,
      clientX: 50,
      clientY: 62,
    });
    fireEvent.pointerMove(overlay, {
      pointerId: 4,
      clientX: 55,
      clientY: 61,
    });
    fireEvent.pointerUp(overlay, { pointerId: 4, clientX: 55, clientY: 61 });

    await waitFor(async () => {
      expect(await localDatabase.annotations.get(ink.key)).toMatchObject({
        deleted: true,
        payload: null,
      });
    });
    expect(await localDatabase.annotations.get(text.key)).toMatchObject({
      deleted: false,
      payload: { kind: "text" },
    });
    expect(await localDatabase.annotations.get(otherInk.key)).toMatchObject({
      deleted: false,
      payload: { kind: "ink" },
    });
    expect(await undoAnnotationEdit(choirId, scoreId, activeLayerId)).toBe(true);
    expect(await undoAnnotationEdit(choirId, scoreId, activeLayerId)).toBe(false);
  });

  it("shows only the active layer while editing and subscriptions while reading", () => {
    const active = annotation("active", activeLayerId, {
      kind: "text",
      pageNumber: 1,
      x: 0.2,
      y: 0.2,
      text: "G 内容",
    });
    const other = annotation("other", otherLayerId, {
      kind: "text",
      pageNumber: 1,
      x: 0.4,
      y: 0.4,
      text: "B 内容",
    });
    const view = renderOverlay([active, other], "text");
    expect(screen.getByRole("button", { name: "G 内容" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "B 内容" })).not.toBeInTheDocument();

    view.rerender(
      <AnnotationOverlay
        choirId={choirId}
        scoreId={scoreId}
        pageNumber={1}
        layers={layers}
        annotations={[active, other]}
        editing={false}
        tool="text"
        activeLayerId={activeLayerId}
      />,
    );
    expect(screen.getByRole("button", { name: "G 内容" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "B 内容" })).toBeInTheDocument();

    view.rerender(
      <AnnotationOverlay
        choirId={choirId}
        scoreId={scoreId}
        pageNumber={1}
        layers={layers}
        annotations={[active, other]}
        editing
        tool="text"
        activeLayerId={otherLayerId}
      />,
    );
    expect(screen.queryByRole("button", { name: "G 内容" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "B 内容" })).toBeInTheDocument();
  });
});

function renderOverlay(annotations: LocalAnnotationRecord[], tool: AnnotationTool) {
  return render(
    <AnnotationOverlay
      choirId={choirId}
      scoreId={scoreId}
      pageNumber={1}
      layers={layers}
      annotations={annotations}
      editing
      tool={tool}
      activeLayerId={activeLayerId}
    />,
  );
}

function annotation(
  id: string,
  layerId: string,
  payload: NonNullable<LocalAnnotationRecord["payload"]>,
): LocalAnnotationRecord {
  return {
    key: annotationRecordKey(scopeKey, id),
    scopeKey,
    choirId,
    scoreId,
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
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
      toJSON: () => ({}),
    }),
  });
}

afterEach(() => endAnnotationEditSession());
