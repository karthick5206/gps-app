-- Point analysis phase 3: leave outliers (spikes, jumps, inaccurate, fake, invalid) out of trips, distance and the History track.
ALTER TABLE "PointQualitySettings" ADD COLUMN "useInReports" BOOLEAN NOT NULL DEFAULT false;
