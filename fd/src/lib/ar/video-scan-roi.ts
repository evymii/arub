/**
 * Central scan ROI — keep in sync with the overlay in `ARShell.tsx`
 * (`h-[42%] max-h-[260px] w-[72%] max-w-[300px]`, centered).
 */
export const SCAN_ROI_WIDTH_FRAC = 0.72;
export const SCAN_ROI_HEIGHT_FRAC = 0.42;
export const SCAN_ROI_MAX_W_PX = 300;
export const SCAN_ROI_MAX_H_PX = 260;
/** MobileNet expects 224; we draw the ROI into this square before `infer`. */
export const SCAN_ROI_MODEL_PX = 224;

let reuseCanvas: HTMLCanvasElement | null = null;

function get2dContext(): CanvasRenderingContext2D | null {
  if (typeof document === "undefined") return null;
  if (!reuseCanvas) {
    reuseCanvas = document.createElement("canvas");
  }
  reuseCanvas.width = SCAN_ROI_MODEL_PX;
  reuseCanvas.height = SCAN_ROI_MODEL_PX;
  return reuseCanvas.getContext("2d", { willReadFrequently: true });
}

/**
 * Maps the visible scan rectangle from element coordinates into intrinsic video
 * pixels for `object-fit: cover` (same math the browser uses to paint the frame).
 */
export function drawVideoScanRoiToCanvas(video: HTMLVideoElement): HTMLCanvasElement | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const W = video.clientWidth;
  const H = video.clientHeight;
  if (vw <= 0 || vh <= 0 || W <= 0 || H <= 0) return null;

  const rw = Math.min(W * SCAN_ROI_WIDTH_FRAC, SCAN_ROI_MAX_W_PX, W);
  const rh = Math.min(H * SCAN_ROI_HEIGHT_FRAC, SCAN_ROI_MAX_H_PX, H);
  const rx = (W - rw) / 2;
  const ry = (H - rh) / 2;

  const scale = Math.max(W / vw, H / vh);
  const offsetX = (W - vw * scale) / 2;
  const offsetY = (H - vh * scale) / 2;

  let sx = (rx - offsetX) / scale;
  let sy = (ry - offsetY) / scale;
  let sw = rw / scale;
  let sh = rh / scale;

  sx = Math.max(0, Math.min(sx, vw - 1e-6));
  sy = Math.max(0, Math.min(sy, vh - 1e-6));
  sw = Math.max(1e-6, Math.min(sw, vw - sx));
  sh = Math.max(1e-6, Math.min(sh, vh - sy));

  const ctx = get2dContext();
  if (!ctx || !reuseCanvas) return null;

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, SCAN_ROI_MODEL_PX, SCAN_ROI_MODEL_PX);
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, SCAN_ROI_MODEL_PX, SCAN_ROI_MODEL_PX);

  return reuseCanvas;
}
