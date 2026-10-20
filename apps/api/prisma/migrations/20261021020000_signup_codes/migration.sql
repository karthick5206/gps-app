-- Personal account sign-up: email verification codes.
CREATE TABLE "SignupCode" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" TIMESTAMPTZ(3),
    "ip" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SignupCode_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SignupCode_email_createdAt_idx" ON "SignupCode"("email", "createdAt" DESC);
