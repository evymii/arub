"use client";

import "@google/model-viewer";

import type { ModelViewerElement } from "@google/model-viewer";
import { createElement, useEffect, useRef, type CSSProperties } from "react";

import { cn } from "@/lib/utils";

type Props = {
  src: string;
  className?: string;
  /** Outer frame (e.g. `h-10 w-10`). Inner model fills this box. */
  frameClassName?: string;
  /** Clip shape for the frame (default circular floaters). */
  frameShapeClassName?: string;
  /** 0–1 full turns; offsets starting angle so icons do not stay in sync. */
  phaseOffsetTurns?: number;
};

/** GLB icon rendered via `<model-viewer>` with lightweight native auto-rotation. */
export function FloatingGlbIcon({
  src,
  className,
  frameClassName,
  frameShapeClassName = "rounded-full",
  phaseOffsetTurns = 0,
}: Props) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const yawRef = useRef(phaseOffsetTurns * Math.PI * 2);
  const phaseRef = useRef(phaseOffsetTurns * Math.PI * 2);

  useEffect(() => {
    phaseRef.current = phaseOffsetTurns * Math.PI * 2;
    yawRef.current = phaseRef.current;
  }, [phaseOffsetTurns]);

  useEffect(() => {
    const el = frameRef.current?.querySelector("model-viewer") as ModelViewerElement | null;
    if (!el) return;
    const setInitialTurn = () => {
      yawRef.current = phaseRef.current;
      el.resetTurntableRotation(yawRef.current);
    };

    el.autoRotate = true;
    el.addEventListener("load", setInitialTurn);
    if (el.loaded) setInitialTurn();

    return () => {
      el.removeEventListener("load", setInitialTurn);
    };
  }, [src]);

  const modelViewer = createElement("model-viewer", {
    src,
    alt: "",
    "auto-rotate": true,
    "auto-rotate-delay": "0",
    "interaction-prompt": "none",
    "disable-zoom": true,
    "shadow-intensity": "0.35",
    exposure: "1",
    "environment-image": "neutral",
    className: cn("h-full w-full bg-transparent opacity-95", className),
    style: { width: "100%", height: "100%" } satisfies CSSProperties,
  });

  return (
    <div
      ref={frameRef}
      className={cn(
        "pointer-events-none overflow-hidden bg-black/40 ring-1 ring-white/30",
        frameShapeClassName,
        frameClassName,
      )}
    >
      {modelViewer}
    </div>
  );
}
