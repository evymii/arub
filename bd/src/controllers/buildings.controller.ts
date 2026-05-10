import type { Request, Response } from "express";
import { z } from "zod";

import { prisma } from "../config/prisma.js";

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  lat: z.number().finite().optional(),
  lng: z.number().finite().optional(),
  isNotBuilding: z.boolean().optional(),
});

const patchSchema = z.object({
  isNotBuilding: z.boolean().optional(),
});

export async function listBuildings(_req: Request, res: Response): Promise<void> {
  const buildings = await prisma.building.findMany({
    select: {
      id: true,
      name: true,
      lat: true,
      lng: true,
      isNotBuilding: true,
      createdAt: true,
      createdById: true,
      _count: { select: { samples: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  res.json({
    buildings: buildings.map((b) => ({
      id: b.id,
      name: b.name,
      lat: b.lat,
      lng: b.lng,
      isNotBuilding: b.isNotBuilding,
      createdAt: b.createdAt,
      createdById: b.createdById,
      sampleCount: b._count.samples,
    })),
  });
}

export async function listBuildingsWithSamples(_req: Request, res: Response): Promise<void> {
  const buildings = await prisma.building.findMany({
    select: {
      id: true,
      name: true,
      lat: true,
      lng: true,
      isNotBuilding: true,
      createdAt: true,
      createdById: true,
      samples: {
        select: {
          id: true,
          embedding: true,
          lat: true,
          lng: true,
          source: true,
        },
        orderBy: { createdAt: "asc" },
      },
      _count: { select: { samples: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  res.json({
    buildings: buildings.map((b) => ({
      id: b.id,
      name: b.name,
      lat: b.lat,
      lng: b.lng,
      isNotBuilding: b.isNotBuilding,
      createdAt: b.createdAt,
      createdById: b.createdById,
      sampleCount: b._count.samples,
      samples: b.samples.map((s) => ({
        id: s.id,
        embedding: JSON.parse(s.embedding) as number[],
        lat: s.lat,
        lng: s.lng,
        source: s.source,
      })),
    })),
  });
}

export async function createBuilding(req: Request, res: Response): Promise<void> {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
    return;
  }
  const { name, lat, lng, isNotBuilding } = parsed.data;
  const existing = await prisma.building.findUnique({
    where: { name },
    select: {
      id: true,
      name: true,
      lat: true,
      lng: true,
      isNotBuilding: true,
      createdAt: true,
      createdById: true,
    },
  });
  if (existing) {
    res.status(200).json({ building: { ...existing, sampleCount: 0 } });
    return;
  }
  const building = await prisma.building.create({
    data: {
      name,
      lat: lat ?? null,
      lng: lng ?? null,
      isNotBuilding: isNotBuilding ?? false,
      createdById: req.userId,
    },
    select: {
      id: true,
      name: true,
      lat: true,
      lng: true,
      isNotBuilding: true,
      createdAt: true,
      createdById: true,
    },
  });
  res.status(201).json({ building: { ...building, sampleCount: 0 } });
}

export async function updateBuilding(
  req: Request<{ id: string }>,
  res: Response,
): Promise<void> {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: "Building id is required" });
    return;
  }
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
    return;
  }
  const building = await prisma.building.findUnique({ where: { id } });
  if (!building) {
    res.status(404).json({ error: "Building not found" });
    return;
  }
  if (building.createdById && building.createdById !== req.userId) {
    res.status(403).json({ error: "Only the creator can update this building" });
    return;
  }
  const data = parsed.data;
  if (Object.keys(data).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }
  const updated = await prisma.building.update({
    where: { id },
    data,
    select: {
      id: true,
      name: true,
      lat: true,
      lng: true,
      isNotBuilding: true,
      createdAt: true,
      createdById: true,
    },
  });
  const sampleCount = await prisma.sample.count({ where: { buildingId: id } });
  res.json({ building: { ...updated, sampleCount } });
}

export async function deleteBuilding(
  req: Request<{ id: string }>,
  res: Response,
): Promise<void> {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: "Building id is required" });
    return;
  }
  const building = await prisma.building.findUnique({ where: { id } });
  if (!building) {
    res.status(404).json({ error: "Building not found" });
    return;
  }
  if (building.createdById && building.createdById !== req.userId) {
    res.status(403).json({ error: "Only the creator can delete this building" });
    return;
  }
  await prisma.building.delete({ where: { id } });
  res.status(204).send();
}
