-- AlterEnum
-- Own migration: a new enum value cannot be used in the same transaction that adds it, and the next migration
-- (20261019210000_licence_credit_notes_api) inserts API_ACCESS seats.
ALTER TYPE "LicenceType" ADD VALUE 'API_ACCESS';
