-- Pricing review fixes (QA 10): who last edited a version / vehicle rate, so maker-checker can refuse that user as approver.
SET lock_timeout = '5s';
ALTER TABLE "PricingContractVersion" ADD COLUMN "lastEditedById" UUID;
ALTER TABLE "PricingVehicleRate" ADD COLUMN "lastEditedById" UUID;
