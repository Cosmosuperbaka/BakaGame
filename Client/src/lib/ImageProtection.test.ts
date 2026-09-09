import { describe, it, expect, vi } from "vitest";
import {
  preventImageDrag,
  setupGlobalImageProtection,
} from "./ImageProtection";

describe("ImageProtection", () => {
  describe("preventImageDrag", () => {
    it("阻止 HTMLImageElement 上的原生 dragstart 事件", () => {
      const img = document.createElement("img");
      const event = new Event("dragstart", { cancelable: true });
      Object.defineProperty(event, "target", { value: img, writable: false });

      preventImageDrag(event);

      expect(event.defaultPrevented).toBe(true);
    });

    it("阻止任意 tagName 为 IMG 的元素的 dragstart 事件", () => {
      const mockImgElement = { tagName: "IMG" } as unknown as HTMLElement;
      const preventDefault = vi.fn();
      const event = {
        target: mockImgElement,
        preventDefault,
      } as unknown as Event;

      preventImageDrag(event);

      expect(preventDefault).toHaveBeenCalledTimes(1);
    });

    it("不阻止 div 等非图片元素的 dragstart 事件", () => {
      const div = document.createElement("div");
      const event = new Event("dragstart", { cancelable: true });
      Object.defineProperty(event, "target", { value: div, writable: false });

      preventImageDrag(event);

      expect(event.defaultPrevented).toBe(false);
    });

    it("不阻止 button 等非图片元素的 dragstart 事件", () => {
      const button = document.createElement("button");
      const event = new Event("dragstart", { cancelable: true });
      Object.defineProperty(event, "target", { value: button, writable: false });

      preventImageDrag(event);

      expect(event.defaultPrevented).toBe(false);
    });

    it("当 target 为 null 或非 Element 时不崩溃且不阻止", () => {
      const preventDefault = vi.fn();
      const event = {
        target: null,
        preventDefault,
      } as unknown as Event;

      preventImageDrag(event);

      expect(preventDefault).not.toHaveBeenCalled();
    });
  });

  describe("setupGlobalImageProtection", () => {
    it("在 window 上全局注册监听并在 img 拖拽时自动阻止", () => {
      const cleanup = setupGlobalImageProtection();

      const img = document.createElement("img");
      document.body.appendChild(img);

      const event = new Event("dragstart", {
        bubbles: true,
        cancelable: true,
      });
      img.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);

      cleanup();
      img.remove();
    });

    it("调用清理函数后，不再自动阻止 dragstart", () => {
      const cleanup = setupGlobalImageProtection();
      cleanup();

      const img = document.createElement("img");
      document.body.appendChild(img);

      const event = new Event("dragstart", {
        bubbles: true,
        cancelable: true,
      });
      img.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(false);

      img.remove();
    });
  });
});
