import { Router } from "express";
import multer from "multer";

import { createSample, deleteSample } from "../controllers/samples.controller.js";
import { requireAuth } from "../middleware/auth.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

export const samplesRouter: Router = Router();

samplesRouter.post("/", requireAuth, upload.single("photo"), createSample);
samplesRouter.delete("/:id", requireAuth, deleteSample);
