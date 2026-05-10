import type { Request, Response } from "express";
import { z } from "zod";

import { cloudinaryConfigured, uploadBuffer } from "../config/cloudinary.js";
import { prisma } from "../config/prisma.js";

const ACCEPT_MATCH_COUNT = 3;
const ACCEPT_UNIQUE_USERS = 2;

const createIssueSchema = z.object({
  title: z.string().trim().min(1).max(180),
  description: z.string().trim().max(1500).optional(),
  buildingId: z.string().trim().min(1).optional(),
  embedding: z.array(z.number().finite()).min(64).max(8192).optional(),
  lat: z.number().finite().optional(),
  lng: z.number().finite().optional(),
});

const matchEventSchema = z.object({
  buildingId: z.string().trim().min(1),
});

function parseCreateIssueBody(req: Request): unknown {
  const raw = req.body?.metadata;
  if (!raw) return req.body;
  if (typeof raw === "string") return JSON.parse(raw);
  return raw;
}

async function computeAndPersistConsensus(issueId: string): Promise<void> {
  const matches = await prisma.issueMatch.findMany({
    where: { issueId },
    select: { userId: true },
  });
  const matchCount = matches.length;
  const uniqueUsers = new Set(matches.map((m) => m.userId)).size;
  const status =
    matchCount >= ACCEPT_MATCH_COUNT && uniqueUsers >= ACCEPT_UNIQUE_USERS ? "accepted" : "consensus";

  await prisma.issue.update({
    where: { id: issueId },
    data: { matchCount, uniqueUsers, status },
  });
}

async function issueView(issueId: string) {
  const issue = await prisma.issue.findUnique({
    where: { id: issueId },
    include: {
      building: { select: { id: true, name: true } },
      _count: { select: { supports: true, comments: true, matches: true } },
    },
  });
  if (!issue) return null;
  return {
    id: issue.id,
    title: issue.title,
    description: issue.description,
    status: issue.status,
    buildingId: issue.buildingId,
    buildingLabel: issue.building?.name ?? null,
    matchCount: issue.matchCount,
    uniqueUsers: issue.uniqueUsers,
    supportCount: issue._count.supports,
    commentCount: issue._count.comments,
    totalMatchEvents: issue._count.matches,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    lat: issue.lat,
    lng: issue.lng,
  };
}

export async function createIssue(req: Request, res: Response): Promise<void> {
  let payload: unknown;
  try {
    payload = parseCreateIssueBody(req);
  } catch {
    res.status(400).json({ error: "metadata is not valid JSON" });
    return;
  }

  const parsed = createIssueSchema.safeParse(payload);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid issue payload", details: parsed.error.issues });
    return;
  }
  const { title, description, buildingId, embedding, lat, lng } = parsed.data;

  let photoUrl: string | null = null;
  let photoPublicId: string | null = null;
  if (req.file) {
    if (!cloudinaryConfigured) {
      res.status(500).json({ error: "Photo upload requested but Cloudinary is not configured." });
      return;
    }
    const uploaded = await uploadBuffer(req.file.buffer, "issues");
    photoUrl = uploaded.secureUrl;
    photoPublicId = uploaded.publicId;
  }

  const issue = await prisma.issue.create({
    data: {
      title,
      description: description ?? null,
      status: "open",
      buildingId: buildingId ?? null,
      embedding: embedding ? JSON.stringify(embedding) : null,
      photoUrl,
      photoPublicId,
      lat: lat ?? null,
      lng: lng ?? null,
      createdById: req.userId!,
    },
  });

  const view = await issueView(issue.id);
  res.status(201).json({ issue: view });
}

export async function getIssueByLabel(req: Request<{ label: string }>, res: Response): Promise<void> {
  const label = req.params.label?.trim();
  if (!label) {
    res.status(400).json({ error: "label is required" });
    return;
  }
  const building = await prisma.building.findUnique({ where: { name: label }, select: { id: true } });
  if (!building) {
    res.json({ issue: null });
    return;
  }

  const latest = await prisma.issue.findFirst({
    where: { buildingId: building.id, status: { in: ["open", "consensus", "accepted"] } },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  if (!latest) {
    res.json({ issue: null });
    return;
  }
  const view = await issueView(latest.id);
  res.json({ issue: view });
}

export async function supportIssue(req: Request<{ id: string }>, res: Response): Promise<void> {
  const issueId = req.params.id;
  if (!issueId) {
    res.status(400).json({ error: "issue id is required" });
    return;
  }
  const existing = await prisma.issueSupport.findUnique({
    where: { issueId_userId: { issueId, userId: req.userId! } },
    select: { id: true },
  });
  if (existing) {
    await prisma.issueSupport.delete({ where: { id: existing.id } });
  } else {
    await prisma.issueSupport.create({ data: { issueId, userId: req.userId! } });
  }
  const view = await issueView(issueId);
  res.json({ issue: view });
}

export async function recordMatchEvent(req: Request<{ id: string }>, res: Response): Promise<void> {
  const issueId = req.params.id;
  if (!issueId) {
    res.status(400).json({ error: "issue id is required" });
    return;
  }
  const parsed = matchEventSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid match event payload", details: parsed.error.issues });
    return;
  }
  await prisma.issueMatch.create({
    data: { issueId, buildingId: parsed.data.buildingId, userId: req.userId! },
  });
  await computeAndPersistConsensus(issueId);
  const view = await issueView(issueId);
  res.status(201).json({ issue: view });
}
