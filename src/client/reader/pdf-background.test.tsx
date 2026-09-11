import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PdfPageCanvas } from './pdf-page';
import type { PDFDocumentProxy } from './pdf-document';
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
it.each([[false, 19000], [false, 20001], [true, 3600000]])('background painted=%s elapsed=%s', async (painted, elapsed) => {
  vi.useFakeTimers();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
  const finishes: Array<() => void> = [];
  const pdf = { getPage: vi.fn().mockResolvedValue({getViewport: () => ({width:600,height:800}), render: () => ({promise: new Promise<void>(r => finishes.push(r)),cancel: vi.fn()})}) } as unknown as PDFDocumentProxy;
  const view = render(<PdfPageCanvas document={pdf} pageNumber={1} width={600}/>);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  if (painted) {
    await act(async () => { finishes[0](); });
  }
  vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
  await act(async () => { await vi.advanceTimersByTimeAsync(Number(elapsed)); });
  vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');
  document.dispatchEvent(new Event('visibilitychange'));
  await act(async () => { finishes.forEach(f => f()); });
  expect(view.queryByText('这一页暂时无法显示')).toBeNull();
});

it('does not start rendering while hidden and resumes only once', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
  const draw = vi.fn(() => ({promise: Promise.resolve(), cancel: vi.fn()}));
  const pdf = { getPage: vi.fn().mockResolvedValue({getViewport: () => ({width:600,height:800}), render: draw}) } as unknown as PDFDocumentProxy;
  const view = render(<PdfPageCanvas document={pdf} pageNumber={1} width={600}/>);
  await act(async () => {});
  expect(draw).not.toHaveBeenCalled();
  await act(async () => {
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pageshow'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(draw).toHaveBeenCalledTimes(1);
  expect(view.container.querySelector('[data-pdf-canvas-active]')).not.toBeNull();
});

it('repaints a restored canvas once and waits for its actual bitmap', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
  const finishes: Array<() => void> = [];
  const draw = vi.fn(() => ({promise: new Promise<void>(r => finishes.push(r)), cancel: vi.fn()}));
  const pdf = { getPage: vi.fn().mockResolvedValue({getViewport: () => ({width:600,height:800}), render: draw}) } as unknown as PDFDocumentProxy;
  const view = render(<PdfPageCanvas document={pdf} pageNumber={1} width={600}/>);
  await act(async () => {});
  await act(async () => { finishes[0](); });
  const canvas = view.container.querySelector('[data-pdf-canvas-active]')!;
  act(() => { canvas.dispatchEvent(new Event('contextlost')); });
  expect(view.container.querySelector('[data-pdf-canvas-active]')).toBeNull();
  await act(async () => {
    canvas.dispatchEvent(new Event('contextrestored'));
    canvas.dispatchEvent(new Event('contextrestored'));
  });
  expect(draw).toHaveBeenCalledTimes(2);
  expect(view.container.querySelector('[data-pdf-canvas-active]')).toBeNull();
  await act(async () => { finishes[1](); });
  expect(view.container.querySelector('[data-pdf-canvas-active]')).not.toBeNull();
});

it('ignores a late old-page render after the hidden target changes', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
  const finishes: Array<() => void> = [];
  const pdf = { getPage: vi.fn().mockResolvedValue({getViewport: () => ({width:600,height:800}), render: () => ({promise: new Promise<void>(r => finishes.push(r)), cancel: vi.fn()})}) } as unknown as PDFDocumentProxy;
  const view = render(<PdfPageCanvas document={pdf} pageNumber={1} width={600}/>);
  await act(async () => {});
  act(() => {
    visibility.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
  });
  view.rerender(<PdfPageCanvas document={pdf} pageNumber={2} width={600}/>);
  await act(async () => { finishes[0](); });
  expect(view.container.querySelector('[data-pdf-canvas-active]')).toBeNull();
  await act(async () => {
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await act(async () => { finishes[1](); });
  expect(view.getByRole('img', {name: '第 2 页'})).toBeInTheDocument();
  expect(view.container.querySelector('[data-pdf-canvas-active]')).not.toBeNull();
});
