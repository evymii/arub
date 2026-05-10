import { Router } from "express";
import multer from "multer";

import {
  createIssue,
  getIssueByLabel,
  recordMatchEvent,
  supportIssue,
} from "../controllers/issues.controller.js";
import {
  createIssueComment,
  listIssueComments,
} from "../controllers/issue-comments.controller.js";
import { requireAuth } from "../middleware/auth.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

export const issuesRouter: Router = Router();

issuesRouter.get("/by-label/:label", getIssueByLabel);
issuesRouter.post("/", requireAuth, upload.single("photo"), createIssue);
issuesRouter.post("/:id/support", requireAuth, supportIssue);
issuesRouter.post("/:id/match-events", requireAuth, recordMatchEvent);
issuesRouter.get("/:id/comments", listIssueComments);
issuesRouter.post("/:id/comments", requireAuth, createIssueComment);
