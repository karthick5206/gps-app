-- OTP SMS: the DLT template registered with Smartping (header VIBHAV, template 1777179276261487525).
-- The text must stay word for word as registered; only {#num#} is filled ({{code}}).
-- The seed never overwrites system templates, so the existing system row is updated here (with a new version).
UPDATE "MessageTemplate"
SET body = 'Thanks for choosing Vibhav Enterprise Solutions VeeTrax fleet tracking solutions platform. Your signup and acitvation code for VeeTrax app is {{code}} . Do not share with anyone. For support please call 9444907658 or https://vibhaventerprise.com',
    "dltTemplateId" = '1777179276261487525',
    "senderId" = 'VIBHAV',
    "approvalStatus" = 'APPROVED',
    version = version + 1,
    "updatedAt" = now()
WHERE "companyId" IS NULL AND purpose = 'SYSTEM_OTP' AND channel = 'SMS' AND "dltTemplateId" IS DISTINCT FROM '1777179276261487525';

INSERT INTO "MessageTemplateVersion" (id, "templateId", version, subject, body, "createdAt")
SELECT gen_random_uuid(), t.id, t.version, t.subject, t.body, now()
FROM "MessageTemplate" t
WHERE t."companyId" IS NULL AND t.purpose = 'SYSTEM_OTP' AND t.channel = 'SMS' AND t."dltTemplateId" = '1777179276261487525'
  AND NOT EXISTS (SELECT 1 FROM "MessageTemplateVersion" v WHERE v."templateId" = t.id AND v.version = t.version);
