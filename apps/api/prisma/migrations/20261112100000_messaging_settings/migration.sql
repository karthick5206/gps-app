-- Messaging channel switches (SMS, e-mail, WhatsApp, Arattai) and the Arattai Business set-up; Arattai alert channel.
-- AlterEnum
ALTER TYPE "NotifyChannel" ADD VALUE 'ARATTAI';

-- CreateTable
CREATE TABLE "MessagingSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "smsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT true,
    "whatsappEnabled" BOOLEAN NOT NULL DEFAULT false,
    "arattaiEnabled" BOOLEAN NOT NULL DEFAULT false,
    "arattaiCompanyId" TEXT NOT NULL DEFAULT '',
    "arattaiBusinessNumberId" TEXT NOT NULL DEFAULT '',
    "arattaiOtpTemplateId" TEXT NOT NULL DEFAULT '',
    "arattaiAlertTemplateId" TEXT NOT NULL DEFAULT '',
    "arattaiLanguage" TEXT NOT NULL DEFAULT 'en',
    "arattaiClientId" TEXT NOT NULL DEFAULT '',
    "arattaiClientSecret" TEXT NOT NULL DEFAULT '',
    "arattaiRefreshToken" TEXT NOT NULL DEFAULT '',
    "arattaiOauthState" TEXT,
    "arattaiConnectedAt" TIMESTAMPTZ(3),
    "arattaiLastSentAt" TIMESTAMPTZ(3),
    "arattaiLastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessagingSettings_pkey" PRIMARY KEY ("id")
);

