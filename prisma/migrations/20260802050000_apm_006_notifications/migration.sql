-- APM-006 notification templates, inbox facts, and delivery history.
CREATE TYPE "NotificationSensitivity" AS ENUM ('INTERNAL', 'RESTRICTED');
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL');
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('PENDING', 'RETRYING', 'SENT', 'DEAD_LETTER');
CREATE TYPE "NotificationDeliveryAttemptStatus" AS ENUM ('RUNNING', 'SENT', 'FAILED');

ALTER TYPE "AuditAction" ADD VALUE 'NOTIFICATION_TEMPLATE_PUBLISHED';
ALTER TYPE "AuditAction" ADD VALUE 'NOTIFICATION_TEMPLATE_STATUS_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'NOTIFICATION_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'NOTIFICATION_INBOX_READ';
ALTER TYPE "AuditAction" ADD VALUE 'NOTIFICATION_MARKED_READ';
ALTER TYPE "AuditAction" ADD VALUE 'NOTIFICATION_DELIVERED';
ALTER TYPE "AuditObjectType" ADD VALUE 'NOTIFICATION_TEMPLATE';
ALTER TYPE "AuditObjectType" ADD VALUE 'NOTIFICATION';
ALTER TYPE "AuditObjectType" ADD VALUE 'NOTIFICATION_DELIVERY';

CREATE TABLE "notification_templates" (
    "code" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "current_version" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("code"),
    CONSTRAINT "notification_templates_code_check" CHECK ("code" ~ '^[A-Z][A-Z0-9_.-]{2,100}$'),
    CONSTRAINT "notification_templates_current_version_check" CHECK ("current_version" >= 0),
    CONSTRAINT "notification_templates_version_check" CHECK ("version" > 0)
);

CREATE TABLE "notification_template_versions" (
    "id" TEXT NOT NULL,
    "template_code" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "subject_template" TEXT NOT NULL,
    "body_text_template" TEXT NOT NULL,
    "body_html_template" TEXT,
    "variable_schema" JSONB NOT NULL,
    "published_by_id" TEXT,
    "published_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notification_template_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notification_template_versions_version_check" CHECK ("version" > 0),
    CONSTRAINT "notification_template_versions_subject_check" CHECK (length("subject_template") BETWEEN 1 AND 998),
    CONSTRAINT "notification_template_versions_body_check" CHECK (length("body_text_template") BETWEEN 1 AND 100000),
    CONSTRAINT "notification_template_versions_schema_check" CHECK (jsonb_typeof("variable_schema") = 'object')
);

CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "source_event_key" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "recipient_id" TEXT NOT NULL,
    "project_id" TEXT,
    "template_version_id" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body_text" TEXT NOT NULL,
    "body_html" TEXT,
    "target_path" TEXT,
    "sensitivity" "NotificationSensitivity" NOT NULL DEFAULT 'INTERNAL',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notifications_source_key_check" CHECK (length(btrim("source_event_key")) BETWEEN 1 AND 191),
    CONSTRAINT "notifications_event_type_check" CHECK (length(btrim("event_type")) BETWEEN 1 AND 191),
    CONSTRAINT "notifications_hash_check" CHECK ("payload_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "notifications_subject_check" CHECK (length("subject") BETWEEN 1 AND 998),
    CONSTRAINT "notifications_body_check" CHECK (length("body_text") BETWEEN 1 AND 100000),
    CONSTRAINT "notifications_target_path_check" CHECK (
        "target_path" IS NULL OR ("target_path" LIKE '/%' AND "target_path" NOT LIKE '//%')
    )
);

CREATE TABLE "notification_read_receipts" (
    "id" TEXT NOT NULL,
    "notification_id" TEXT NOT NULL,
    "recipient_id" TEXT NOT NULL,
    "read_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notification_read_receipts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notification_deliveries" (
    "id" TEXT NOT NULL,
    "notification_id" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "idempotency_key" TEXT NOT NULL,
    "sent_at" TIMESTAMP(3),
    "provider_message_id" TEXT,
    "last_error_code" TEXT,
    "last_error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notification_deliveries_key_check" CHECK (length(btrim("idempotency_key")) BETWEEN 1 AND 191),
    CONSTRAINT "notification_deliveries_sent_check" CHECK (
        ("status" = 'SENT' AND "sent_at" IS NOT NULL AND "provider_message_id" IS NOT NULL)
        OR ("status" <> 'SENT' AND "sent_at" IS NULL)
    )
);

CREATE TABLE "notification_delivery_attempts" (
    "id" TEXT NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "status" "NotificationDeliveryAttemptStatus" NOT NULL DEFAULT 'RUNNING',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "provider_message_id" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    CONSTRAINT "notification_delivery_attempts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notification_delivery_attempts_number_check" CHECK ("attempt_number" > 0),
    CONSTRAINT "notification_delivery_attempts_completion_check" CHECK (
        (
            "status" = 'RUNNING'
            AND "completed_at" IS NULL
            AND "provider_message_id" IS NULL
            AND "error_code" IS NULL
            AND "error_message" IS NULL
        ) OR (
            "status" = 'SENT'
            AND "completed_at" IS NOT NULL
            AND "provider_message_id" IS NOT NULL
            AND "error_code" IS NULL
            AND "error_message" IS NULL
        ) OR (
            "status" = 'FAILED'
            AND "completed_at" IS NOT NULL
            AND "provider_message_id" IS NULL
            AND "error_code" IS NOT NULL
            AND "error_message" IS NOT NULL
        )
    )
);

CREATE UNIQUE INDEX "notification_template_versions_template_code_version_key"
    ON "notification_template_versions"("template_code", "version");
CREATE INDEX "notification_template_versions_published_by_id_published_at_idx"
    ON "notification_template_versions"("published_by_id", "published_at");
CREATE UNIQUE INDEX "notifications_source_event_key_recipient_id_key"
    ON "notifications"("source_event_key", "recipient_id");
CREATE UNIQUE INDEX "notifications_id_recipient_id_key" ON "notifications"("id", "recipient_id");
CREATE INDEX "notifications_recipient_id_created_at_idx" ON "notifications"("recipient_id", "created_at");
CREATE INDEX "notifications_recipient_id_sensitivity_created_at_idx"
    ON "notifications"("recipient_id", "sensitivity", "created_at");
CREATE INDEX "notifications_project_id_created_at_idx" ON "notifications"("project_id", "created_at");
CREATE UNIQUE INDEX "notification_read_receipts_notification_id_key"
    ON "notification_read_receipts"("notification_id");
CREATE UNIQUE INDEX "notification_read_receipts_notification_id_recipient_id_key"
    ON "notification_read_receipts"("notification_id", "recipient_id");
CREATE INDEX "notification_read_receipts_recipient_id_read_at_idx"
    ON "notification_read_receipts"("recipient_id", "read_at");
CREATE UNIQUE INDEX "notification_deliveries_idempotency_key_key"
    ON "notification_deliveries"("idempotency_key");
CREATE UNIQUE INDEX "notification_deliveries_notification_id_channel_key"
    ON "notification_deliveries"("notification_id", "channel");
CREATE INDEX "notification_deliveries_status_created_at_idx"
    ON "notification_deliveries"("status", "created_at");
CREATE UNIQUE INDEX "notification_delivery_attempts_delivery_id_attempt_number_key"
    ON "notification_delivery_attempts"("delivery_id", "attempt_number");

ALTER TABLE "notification_template_versions" ADD CONSTRAINT "notification_template_versions_template_code_fkey"
    FOREIGN KEY ("template_code") REFERENCES "notification_templates"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notification_template_versions" ADD CONSTRAINT "notification_template_versions_published_by_id_fkey"
    FOREIGN KEY ("published_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_id_fkey"
    FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_template_version_id_fkey"
    FOREIGN KEY ("template_version_id") REFERENCES "notification_template_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notification_read_receipts" ADD CONSTRAINT "notification_read_receipts_notification_recipient_fkey"
    FOREIGN KEY ("notification_id", "recipient_id") REFERENCES "notifications"("id", "recipient_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notification_read_receipts" ADD CONSTRAINT "notification_read_receipts_recipient_id_fkey"
    FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_fkey"
    FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notification_delivery_attempts" ADD CONSTRAINT "notification_delivery_attempts_delivery_id_fkey"
    FOREIGN KEY ("delivery_id") REFERENCES "notification_deliveries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION reject_notification_immutable_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION '% is immutable: % is forbidden', TG_TABLE_NAME, TG_OP
        USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER notification_template_versions_reject_update_delete
    BEFORE UPDATE OR DELETE ON "notification_template_versions"
    FOR EACH STATEMENT EXECUTE FUNCTION reject_notification_immutable_mutation();
CREATE TRIGGER notification_template_versions_reject_truncate
    BEFORE TRUNCATE ON "notification_template_versions"
    FOR EACH STATEMENT EXECUTE FUNCTION reject_notification_immutable_mutation();
CREATE TRIGGER notifications_reject_update_delete
    BEFORE UPDATE OR DELETE ON "notifications"
    FOR EACH STATEMENT EXECUTE FUNCTION reject_notification_immutable_mutation();
CREATE TRIGGER notifications_reject_truncate
    BEFORE TRUNCATE ON "notifications"
    FOR EACH STATEMENT EXECUTE FUNCTION reject_notification_immutable_mutation();
CREATE TRIGGER notification_read_receipts_reject_update_delete
    BEFORE UPDATE OR DELETE ON "notification_read_receipts"
    FOR EACH STATEMENT EXECUTE FUNCTION reject_notification_immutable_mutation();
CREATE TRIGGER notification_read_receipts_reject_truncate
    BEFORE TRUNCATE ON "notification_read_receipts"
    FOR EACH STATEMENT EXECUTE FUNCTION reject_notification_immutable_mutation();
CREATE FUNCTION enforce_notification_delivery_attempt_transition() RETURNS trigger AS $$
BEGIN
    IF OLD."status" IN ('SENT', 'FAILED') THEN
        RAISE EXCEPTION 'terminal notification delivery attempts are immutable'
            USING ERRCODE = '55000';
    END IF;
    IF OLD."delivery_id" IS DISTINCT FROM NEW."delivery_id"
        OR OLD."attempt_number" IS DISTINCT FROM NEW."attempt_number"
        OR OLD."started_at" IS DISTINCT FROM NEW."started_at" THEN
        RAISE EXCEPTION 'notification delivery attempt identity is immutable'
            USING ERRCODE = '55000';
    END IF;
    IF NEW."status" NOT IN ('SENT', 'FAILED') THEN
        RAISE EXCEPTION 'invalid notification delivery attempt transition'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER notification_delivery_attempts_enforce_transition
    BEFORE UPDATE ON "notification_delivery_attempts"
    FOR EACH ROW EXECUTE FUNCTION enforce_notification_delivery_attempt_transition();
CREATE TRIGGER notification_delivery_attempts_reject_delete
    BEFORE DELETE ON "notification_delivery_attempts"
    FOR EACH STATEMENT EXECUTE FUNCTION reject_notification_immutable_mutation();
CREATE TRIGGER notification_delivery_attempts_reject_truncate
    BEFORE TRUNCATE ON "notification_delivery_attempts"
    FOR EACH STATEMENT EXECUTE FUNCTION reject_notification_immutable_mutation();

INSERT INTO "notification_templates" (
    "code", "enabled", "current_version", "version", "updated_at"
) VALUES ('SYSTEM.GENERIC', true, 1, 1, CURRENT_TIMESTAMP);
INSERT INTO "notification_template_versions" (
    "id", "template_code", "version", "subject_template", "body_text_template", "variable_schema"
) VALUES (
    'notification-template-system-generic-v1',
    'SYSTEM.GENERIC',
    1,
    '{{title}}',
    '{{message}}',
    '{"title":{"type":"string","required":true},"message":{"type":"string","required":true}}'::jsonb
);

INSERT INTO "permissions" ("id", "code", "description") VALUES
('permission-notification-read', 'NOTIFICATION_READ', '读取并标记本人的站内通知'),
('permission-sensitive-notification-read', 'SENSITIVE_NOTIFICATION_READ', '读取授权项目中的受限通知'),
('permission-notification-template-manage', 'NOTIFICATION_TEMPLATE_MANAGE', '发布和停用通知模板版本');

INSERT INTO "role_permissions" ("role_id", "permission_id", "scope") VALUES
('role-project-manager', 'permission-notification-read', 'SELF'),
('role-project-manager', 'permission-sensitive-notification-read', 'PROJECT'),
('role-department-lead', 'permission-notification-read', 'SELF'),
('role-engineer', 'permission-notification-read', 'SELF'),
('role-procurement', 'permission-notification-read', 'SELF'),
('role-quality', 'permission-notification-read', 'SELF'),
('role-quality', 'permission-sensitive-notification-read', 'PROJECT'),
('role-executive', 'permission-notification-read', 'SELF'),
('role-admin', 'permission-notification-read', 'SELF'),
('role-admin', 'permission-sensitive-notification-read', 'ALL'),
('role-admin', 'permission-notification-template-manage', 'ALL');
