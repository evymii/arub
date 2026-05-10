-- Add persisted not-building flag for recognition rejector classes.
ALTER TABLE "Building" ADD COLUMN "isNotBuilding" BOOLEAN NOT NULL DEFAULT false;
