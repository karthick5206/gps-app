-- Where the phone was when the check-in selfie was taken. Empty for selfies from before this column.
ALTER TABLE "AttendanceSelfie" ADD COLUMN "lat" DOUBLE PRECISION;
ALTER TABLE "AttendanceSelfie" ADD COLUMN "lng" DOUBLE PRECISION;
