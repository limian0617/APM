-- APM-005 file facts, upload state, and stable command vocabulary.
CREATE TYPE "FileObjectStatus" AS ENUM (
    'UPLOADING',
    'PENDING_SCAN',
    'AVAILABLE',
    'QUARANTINED',
    'FAILED'
);
CREATE TYPE "FileStorageArea" AS ENUM ('QUARANTINE', 'CONTROLLED');
CREATE TYPE "FileSensitivity" AS ENUM ('INTERNAL', 'RESTRICTED');
CREATE TYPE "FileUploadSessionStatus" AS ENUM (
    'INITIATED',
    'COMPLETING',
    'COMPLETED',
    'FAILED',
    'ABORTED'
);
CREATE TYPE "FileCommandType" AS ENUM ('UPLOAD_COMPLETE');
CREATE TYPE "FileCommandStatus" AS ENUM ('STARTED', 'SUCCEEDED', 'FAILED');

ALTER TYPE "AuditAction" ADD VALUE 'FILE_UPLOAD_STARTED';
ALTER TYPE "AuditAction" ADD VALUE 'FILE_UPLOAD_COMPLETED';
ALTER TYPE "AuditAction" ADD VALUE 'FILE_SCAN_COMPLETED';
ALTER TYPE "AuditAction" ADD VALUE 'FILE_QUARANTINED';
ALTER TYPE "AuditAction" ADD VALUE 'FILE_PROCESSING_FAILED';
ALTER TYPE "AuditAction" ADD VALUE 'FILE_DOWNLOAD_URL_ISSUED';
ALTER TYPE "AuditObjectType" ADD VALUE 'FILE_OBJECT';
ALTER TYPE "AuditObjectType" ADD VALUE 'FILE_UPLOAD_SESSION';

CREATE TABLE "file_objects" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "uploaded_by_id" TEXT NOT NULL,
    "original_name" TEXT NOT NULL,
    "declared_mime_type" TEXT NOT NULL,
    "verified_mime_type" TEXT,
    "declared_size" BIGINT NOT NULL,
    "verified_size" BIGINT,
    "sha256" TEXT,
    "object_key" TEXT NOT NULL,
    "storage_area" "FileStorageArea" NOT NULL DEFAULT 'QUARANTINE',
    "status" "FileObjectStatus" NOT NULL DEFAULT 'UPLOADING',
    "sensitivity" "FileSensitivity" NOT NULL DEFAULT 'INTERNAL',
    "scan_engine" TEXT,
    "scanner_version" TEXT,
    "scan_signature" TEXT,
    "scanned_at" TIMESTAMP(3),
    "failure_code" TEXT,
    "failure_message" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "file_objects_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "file_objects_name_check" CHECK (length(btrim("original_name")) BETWEEN 1 AND 255),
    CONSTRAINT "file_objects_mime_check" CHECK (length(btrim("declared_mime_type")) BETWEEN 3 AND 191),
    CONSTRAINT "file_objects_declared_size_check" CHECK ("declared_size" > 0),
    CONSTRAINT "file_objects_verified_size_check" CHECK ("verified_size" IS NULL OR "verified_size" > 0),
    CONSTRAINT "file_objects_version_check" CHECK ("version" > 0),
    CONSTRAINT "file_objects_opaque_key_check" CHECK (
        "object_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
    CONSTRAINT "file_objects_sha256_check" CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "file_objects_available_check" CHECK (
        "status" <> 'AVAILABLE'
        OR (
            "storage_area" = 'CONTROLLED'
            AND "verified_size" IS NOT NULL
            AND "verified_mime_type" IS NOT NULL
            AND "sha256" IS NOT NULL
            AND "scanned_at" IS NOT NULL
        )
    )
);

CREATE TABLE "file_upload_sessions" (
    "id" TEXT NOT NULL,
    "file_object_id" TEXT NOT NULL,
    "storage_upload_id" TEXT NOT NULL,
    "status" "FileUploadSessionStatus" NOT NULL DEFAULT 'INITIATED',
    "expected_parts" INTEGER NOT NULL,
    "part_size" BIGINT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "failure_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "file_upload_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "file_upload_sessions_parts_check" CHECK ("expected_parts" BETWEEN 1 AND 10000),
    CONSTRAINT "file_upload_sessions_part_size_check" CHECK ("part_size" > 0),
    CONSTRAINT "file_upload_sessions_completion_check" CHECK (
        ("status" = 'COMPLETED' AND "completed_at" IS NOT NULL)
        OR ("status" <> 'COMPLETED' AND "completed_at" IS NULL)
    )
);

CREATE TABLE "file_upload_parts" (
    "upload_session_id" TEXT NOT NULL,
    "part_number" INTEGER NOT NULL,
    "expected_size" BIGINT NOT NULL,
    "completed_size" BIGINT,
    "etag" TEXT,
    CONSTRAINT "file_upload_parts_pkey" PRIMARY KEY ("upload_session_id", "part_number"),
    CONSTRAINT "file_upload_parts_number_check" CHECK ("part_number" BETWEEN 1 AND 10000),
    CONSTRAINT "file_upload_parts_expected_size_check" CHECK ("expected_size" > 0),
    CONSTRAINT "file_upload_parts_completed_size_check" CHECK ("completed_size" IS NULL OR "completed_size" > 0)
);

CREATE TABLE "file_commands" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "file_object_id" TEXT NOT NULL,
    "upload_session_id" TEXT,
    "operation" "FileCommandType" NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "status" "FileCommandStatus" NOT NULL DEFAULT 'STARTED',
    "response_json" JSONB,
    "error_code" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "file_commands_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "file_commands_key_check" CHECK (length(btrim("idempotency_key")) BETWEEN 1 AND 191),
    CONSTRAINT "file_commands_hash_check" CHECK ("payload_hash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "file_objects_object_key_key" ON "file_objects"("object_key");
CREATE INDEX "file_objects_project_id_status_created_at_idx" ON "file_objects"("project_id", "status", "created_at");
CREATE INDEX "file_objects_uploaded_by_id_created_at_idx" ON "file_objects"("uploaded_by_id", "created_at");
CREATE UNIQUE INDEX "file_upload_sessions_file_object_id_key" ON "file_upload_sessions"("file_object_id");
CREATE UNIQUE INDEX "file_upload_sessions_storage_upload_id_key" ON "file_upload_sessions"("storage_upload_id");
CREATE INDEX "file_upload_sessions_status_expires_at_idx" ON "file_upload_sessions"("status", "expires_at");
CREATE UNIQUE INDEX "file_commands_actor_id_operation_idempotency_key_key"
    ON "file_commands"("actor_id", "operation", "idempotency_key");
CREATE UNIQUE INDEX "file_commands_upload_session_id_operation_key"
    ON "file_commands"("upload_session_id", "operation");
CREATE INDEX "file_commands_file_object_id_created_at_idx" ON "file_commands"("file_object_id", "created_at");

ALTER TABLE "file_objects" ADD CONSTRAINT "file_objects_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "file_objects" ADD CONSTRAINT "file_objects_uploaded_by_id_fkey"
    FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "file_upload_sessions" ADD CONSTRAINT "file_upload_sessions_file_object_id_fkey"
    FOREIGN KEY ("file_object_id") REFERENCES "file_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "file_upload_parts" ADD CONSTRAINT "file_upload_parts_upload_session_id_fkey"
    FOREIGN KEY ("upload_session_id") REFERENCES "file_upload_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "file_commands" ADD CONSTRAINT "file_commands_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "file_commands" ADD CONSTRAINT "file_commands_file_object_id_fkey"
    FOREIGN KEY ("file_object_id") REFERENCES "file_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "file_commands" ADD CONSTRAINT "file_commands_upload_session_id_fkey"
    FOREIGN KEY ("upload_session_id") REFERENCES "file_upload_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION validate_file_object_status_transition() RETURNS trigger AS $$
BEGIN
    IF NEW."status" = OLD."status" THEN
        RETURN NEW;
    END IF;
    IF OLD."status" = 'UPLOADING' AND NEW."status" IN ('PENDING_SCAN', 'FAILED') THEN
        RETURN NEW;
    END IF;
    IF OLD."status" = 'PENDING_SCAN' AND NEW."status" IN ('AVAILABLE', 'QUARANTINED', 'FAILED') THEN
        RETURN NEW;
    END IF;
    IF OLD."status" = 'FAILED' AND NEW."status" = 'PENDING_SCAN' THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'invalid file status transition: % -> %', OLD."status", NEW."status"
        USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER file_objects_validate_status_transition
    BEFORE UPDATE OF "status" ON "file_objects"
    FOR EACH ROW EXECUTE FUNCTION validate_file_object_status_transition();

INSERT INTO "permissions" ("id", "code", "description") VALUES
('permission-file-upload', 'FILE_UPLOAD', '向授权项目上传文件'),
('permission-file-download', 'FILE_DOWNLOAD', '下载授权项目中的可用文件'),
('permission-sensitive-file-read', 'SENSITIVE_FILE_READ', '读取受限密级文件');

INSERT INTO "role_permissions" ("role_id", "permission_id", "scope") VALUES
('role-project-manager', 'permission-file-upload', 'PROJECT'),
('role-project-manager', 'permission-file-download', 'PROJECT'),
('role-project-manager', 'permission-sensitive-file-read', 'PROJECT'),
('role-department-lead', 'permission-file-upload', 'DEPARTMENT'),
('role-department-lead', 'permission-file-download', 'DEPARTMENT'),
('role-engineer', 'permission-file-upload', 'PROJECT'),
('role-engineer', 'permission-file-download', 'PROJECT'),
('role-procurement', 'permission-file-upload', 'PROJECT'),
('role-procurement', 'permission-file-download', 'PROJECT'),
('role-quality', 'permission-file-upload', 'PROJECT'),
('role-quality', 'permission-file-download', 'PROJECT'),
('role-quality', 'permission-sensitive-file-read', 'PROJECT'),
('role-executive', 'permission-file-download', 'ALL'),
('role-admin', 'permission-file-upload', 'ALL'),
('role-admin', 'permission-file-download', 'ALL'),
('role-admin', 'permission-sensitive-file-read', 'ALL');
