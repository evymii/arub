import cors from "cors";
import express from "express";

import { cloudinaryConfigured } from "./config/cloudinary.js";
import { env } from "./config/env.js";
import { errorHandler, notFound } from "./middleware/errorHandler.js";
import { authRouter } from "./routes/auth.routes.js";
import { buildingsRouter } from "./routes/buildings.routes.js";
import { issuesRouter } from "./routes/issues.routes.js";
import { samplesRouter } from "./routes/samples.routes.js";

const app = express();

app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
app.use(express.json({ limit: "16mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    cloudinary: cloudinaryConfigured ? "configured" : "missing",
  });
});

app.use("/auth", authRouter);
app.use("/buildings", buildingsRouter);
app.use("/samples", samplesRouter);
app.use("/issues", issuesRouter);

app.use(notFound);
app.use(errorHandler);

app.listen(env.PORT, () => {
  console.log(`bd: listening on http://localhost:${env.PORT}`);
  if (!cloudinaryConfigured) {
    console.warn(
      "bd: Cloudinary credentials not set. Photo uploads will fail until you fill in CLOUDINARY_* in .env",
    );
  }
});
