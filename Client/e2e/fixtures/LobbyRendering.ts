import type { Locator } from "@playwright/test";

/** Validate paint/geometry, not atomic classes or a fixed wrapping depth. */
export async function assertLobbyRendering(card: Locator) {
  const metrics = await card.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is required for computed color alpha");
    let paintedAlpha = 0;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const rect = node.getBoundingClientRect();
      if (Math.abs(rect.width - box.width) > 1 || Math.abs(rect.height - box.height) > 1) break;
      context.clearRect(0, 0, 1, 1);
      const style = getComputedStyle(node);
      context.fillStyle = style.backgroundColor;
      context.fillRect(0, 0, 1, 1);
      const alpha = context.getImageData(0, 0, 1, 1).data[3] / 255 * Number(style.opacity);
      paintedAlpha += (1 - paintedAlpha) * alpha;
    }
    const counts = [...element.querySelectorAll("span")].filter(node => /^\d+$/.test(node.textContent ?? "") && /^(玩家|旁观)$/.test(node.nextSibling?.textContent ?? ""));
    return {
      paintedAlpha,
      overflow: (element as HTMLElement).scrollWidth > (element as HTMLElement).clientWidth + 1,
      numericWidths: counts.map(node => node.getBoundingClientRect().width),
      numericRightAligned: counts.every(node => getComputedStyle(node).textAlign === "right"),
      viewportFits: box.left >= -1 && box.right <= innerWidth + 1,
    };
  });
  if (metrics.paintedAlpha < 0.99) throw new Error("Lobby card background is translucent");
  if (metrics.overflow || !metrics.viewportFits) throw new Error("Lobby card overflows its viewport");
  if (metrics.numericWidths.length !== 2 || Math.abs(metrics.numericWidths[0] - metrics.numericWidths[1]) > 1 || !metrics.numericRightAligned) throw new Error("Lobby counts are not equal-width right-aligned");
  return metrics;
}
