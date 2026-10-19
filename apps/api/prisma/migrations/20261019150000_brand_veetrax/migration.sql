-- Brand rename VeeTracer → Veetrax for stored names and the built-in (company-less) message templates.
-- Company-level templates are the customer's own text and are left alone.
UPDATE "Partner" SET "name" = 'Veetrax' WHERE "slug" = 'veetracer' AND "name" = 'VeeTracer';
UPDATE "Company" SET "name" = 'Veetrax Platform' WHERE "isPlatform" = true AND "name" = 'VeeTracer Platform';
UPDATE "MessageTemplate"
SET "name" = replace("name", 'VeeTracer', 'Veetrax'),
    "subject" = replace("subject", 'VeeTracer', 'Veetrax'),
    "body" = replace("body", 'VeeTracer', 'Veetrax')
WHERE "companyId" IS NULL
  AND ("name" LIKE '%VeeTracer%' OR "subject" LIKE '%VeeTracer%' OR "body" LIKE '%VeeTracer%');
-- Brand colour in the built-in e-mail layout: old teal → Veetrax teal.
UPDATE "MessageTemplate" SET "body" = replace("body", '#0f766e', '#0e5e57') WHERE "companyId" IS NULL AND "body" LIKE '%#0f766e%';
