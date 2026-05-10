import { Router } from "express";

import {
  createBuilding,
  deleteBuilding,
  listBuildings,
  listBuildingsWithSamples,
  updateBuilding,
} from "../controllers/buildings.controller.js";
import { listBuildingSamples } from "../controllers/samples.controller.js";
import { requireAuth } from "../middleware/auth.js";

export const buildingsRouter: Router = Router();

buildingsRouter.get("/", listBuildings);
buildingsRouter.get("/with-samples", listBuildingsWithSamples);
buildingsRouter.post("/", requireAuth, createBuilding);
buildingsRouter.patch("/:id", requireAuth, updateBuilding);
buildingsRouter.delete("/:id", requireAuth, deleteBuilding);
buildingsRouter.get("/:id/samples", listBuildingSamples);
