import type { Request, Response } from "express";
import { z } from "zod";

import {
  cloudinaryConfigured,
  deletePublicId,
  uploadBuffer,
} from "../config/cloudinary.js";
import { prisma } from "../config/prisma.js";

const sampleSchema = z.object({
  buildingId: z.string().min(1),
  embedding: z.array(z.number().finite()).min(64).max(8192),
  lat: z.number().finite().optional(),
  lng: z.number().finite().optional(),
  source: z.enum(["camera", "photo"]),
});

export async function listBuildingSamples(
  req: Request<{ id: string }>,
  res: Response,
): Promise<void> {
  const buildingId = req.params.id;
  if (!buildingId) {
    res.status(400).json({ error: "Building id is required" });
    return;
  }
  const samples = await prisma.sample.findMany({
    where: { buildingId },
    select: {
      id: true,
      embedding: true,
      lat: true,
      lng: true,
      source: true,
      photoUrl: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
  res.json({
    samples: samples.map((s) => ({
      id: s.id,
      embedding: JSON.parse(s.embedding) as number[],
      lat: s.lat,
      lng: s.lng,
      source: s.source,
      photoUrl: s.photoUrl,
      createdAt: s.createdAt,
    })),
  });
}

export async function createSample(req: Request, res: Response): Promise<void> {
  const raw = req.body.metadata;
  if (!raw) {
    res.status(400).json({ error: "metadata field is required" });
    return;
  }
  let metadataJson: unknown;
  try {
    metadataJson = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    res.status(400).json({ error: "metadata is not valid JSON" });
    return;
  }
  const parsed = sampleSchema.safeParse(metadataJson);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid sample metadata", details: parsed.error.issues });
    return;
  }
  const { buildingId, embedding, lat, lng, source } = parsed.data;

  const building = await prisma.building.findUnique({ where: { id: buildingId } });
  if (!building) {
    res.status(404).json({ error: "Building not found" });
    return;
  }

  let photoUrl: string | null = null;
  let photoPublicId: string | null = null;
  if (source === "photo" && req.file) {
    if (!cloudinaryConfigured) {
      res.status(500).json({
        error: "Photo upload requested but Cloudinary credentials are not configured.",
      });
      return;
    }
    try {
      const uploaded = await uploadBuffer(req.file.buffer, `building-ar/${buildingId}`);
      photoUrl = uploaded.secureUrl;
      photoPublicId = uploaded.publicId;
    } catch (e) {
      console.error("Cloudinary upload failed:", e);
      res.status(502).json({ error: "Photo upload failed" });
      return;
    }
  }

  const sample = await prisma.sample.create({
    data: {
      buildingId,
      userId: req.userId!,
      embedding: JSON.stringify(embedding),
      lat: lat ?? null,
      lng: lng ?? null,
      source,
      photoUrl,
      photoPublicId,
    },
    select: {
      id: true,
      buildingId: true,
      lat: true,
      lng: true,
      source: true,
      photoUrl: true,
      createdAt: true,
    },
  });
  res.status(201).json({ sample });
}

export async function deleteSample(
  req: Request<{ id: string }>,
  res: Response,
): Promise<void> {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: "Sample id is required" });
    return;
  }
  const sample = await prisma.sample.findUnique({ where: { id } });
  if (!sample) {
    res.status(404).json({ error: "Sample not found" });
    return;
  }
  if (sample.userId !== req.userId) {
    res.status(403).json({ error: "Only the contributor can delete this sample" });
    return;
  }
  if (sample.photoPublicId) await deletePublicId(sample.photoPublicId);
  await prisma.sample.delete({ where: { id } });
  res.status(204).send();
}
