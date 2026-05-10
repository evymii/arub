import type { Request, Response } from "express";
import { z } from "zod";

import { prisma } from "../config/prisma.js";

const createCommentSchema = z.object({
  body: z.string().trim().min(1).max(2000),
});

export async function listIssueComments(
  req: Request<{ id: string }>,
  res: Response,
): Promise<void> {
  const issueId = req.params.id;
  if (!issueId) {
    res.status(400).json({ error: "issue id is required" });
    return;
  }

  const comments = await prisma.issueComment.findMany({
    where: { issueId },
    select: {
      id: true,
      body: true,
      createdAt: true,
      updatedAt: true,
      user: { select: { id: true, name: true, email: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  res.json({
    comments: comments.map((comment) => ({
      id: comment.id,
      body: comment.body,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      author: comment.user,
    })),
  });
}

export async function createIssueComment(
  req: Request<{ id: string }>,
  res: Response,
): Promise<void> {
  const issueId = req.params.id;
  if (!issueId) {
    res.status(400).json({ error: "issue id is required" });
    return;
  }
  const parsed = createCommentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid comment payload", details: parsed.error.issues });
    return;
  }

  const created = await prisma.issueComment.create({
    data: {
      issueId,
      userId: req.userId!,
      body: parsed.data.body,
    },
    select: {
      id: true,
      body: true,
      createdAt: true,
      updatedAt: true,
      user: { select: { id: true, name: true, email: true } },
    },
  });

  res.status(201).json({
    comment: {
      id: created.id,
      body: created.body,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
      author: created.user,
    },
  });
}
