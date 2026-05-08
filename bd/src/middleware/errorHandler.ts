import type { NextFunction, Request, Response } from "express";

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: "Not found" });
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  console.error("Unhandled error:", err);
  if (res.headersSent) return;
  const message = err instanceof Error ? err.message : "Internal server error";
  res.status(500).json({ error: message });
}
