-- Data forwarding: body format of HTTP_JSON targets. Additive; existing targets keep the VeeTrax batch body.
ALTER TABLE "RelayTarget" ADD COLUMN "format" TEXT NOT NULL DEFAULT 'BATCH';
