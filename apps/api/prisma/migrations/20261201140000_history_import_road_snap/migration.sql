-- History import road snapping: number of points added along the roads. Additive.
ALTER TABLE "HistoryImport" ADD COLUMN "snappedPoints" INTEGER NOT NULL DEFAULT 0;
