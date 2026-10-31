-- Fuel entries: tank filled to full (mileage between two full fill-ups).
ALTER TABLE "Expense" ADD COLUMN "fullTank" BOOLEAN NOT NULL DEFAULT true;
