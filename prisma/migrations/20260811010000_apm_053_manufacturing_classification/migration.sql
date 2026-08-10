-- APM-053: controlled manufacturing classification and internal drawing selections.
CREATE TYPE "DrawingSelectionSetStatus" AS ENUM ('DRAFT', 'LOCKED');
CREATE TYPE "DrawingSelectionItemPurpose" AS ENUM ('INQUIRY', 'MANUFACTURING', 'CHANGE', 'REFERENCE');
CREATE TYPE "DrawingSelectionItemMatchState" AS ENUM ('DEFAULT_MATCH', 'EXCEPTION', 'NO_MATCH');

CREATE TABLE "manufacturing_categories" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "manufacturing_categories_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "manufacturing_categories_code_key" UNIQUE ("code"),
  CONSTRAINT "manufacturing_categories_code_check" CHECK (
    "code" ~ '^[A-Z][A-Z0-9._-]{0,63}$'
  ),
  CONSTRAINT "manufacturing_categories_name_check" CHECK (
    length(btrim("name")) BETWEEN 1 AND 191
  ),
  CONSTRAINT "manufacturing_categories_sort_order_check" CHECK ("sort_order" >= 0),
  CONSTRAINT "manufacturing_categories_version_check" CHECK ("version" > 0)
);

CREATE TABLE "process_tags" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "process_tags_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "process_tags_code_key" UNIQUE ("code"),
  CONSTRAINT "process_tags_code_check" CHECK (
    "code" ~ '^[A-Z][A-Z0-9._-]{0,63}$'
  ),
  CONSTRAINT "process_tags_name_check" CHECK (
    length(btrim("name")) BETWEEN 1 AND 191
  ),
  CONSTRAINT "process_tags_sort_order_check" CHECK ("sort_order" >= 0),
  CONSTRAINT "process_tags_version_check" CHECK ("version" > 0)
);

ALTER TABLE "mechanical_drawings"
  ADD COLUMN "manufacturing_category_id" TEXT;

CREATE TABLE "mechanical_drawing_process_tags" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "drawing_id" TEXT NOT NULL,
  "process_tag_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mechanical_drawing_process_tags_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "supplier_reference_manufacturing_capabilities" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "supplier_reference_id" TEXT NOT NULL,
  "manufacturing_category_id" TEXT NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "supplier_reference_manufacturing_capabilities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "supplier_reference_manufacturing_capabilities_version_check" CHECK ("version" > 0)
);

CREATE TABLE "supplier_reference_process_capabilities" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "supplier_capability_id" TEXT NOT NULL,
  "process_tag_id" TEXT NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "supplier_reference_process_capabilities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "supplier_reference_process_capabilities_version_check" CHECK ("version" > 0)
);

CREATE TABLE "drawing_selection_sets" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "status" "DrawingSelectionSetStatus" NOT NULL DEFAULT 'DRAFT',
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "drawing_selection_sets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "drawing_selection_sets_code_check" CHECK (
    "code" ~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'
  ),
  CONSTRAINT "drawing_selection_sets_title_check" CHECK (
    length(btrim("title")) BETWEEN 1 AND 256
  ),
  CONSTRAINT "drawing_selection_sets_version_check" CHECK ("version" > 0)
);

CREATE TABLE "drawing_selection_items" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "selection_set_id" TEXT NOT NULL,
  "drawing_id" TEXT NOT NULL,
  "document_version_id" TEXT NOT NULL,
  "manufacturing_category_code_snapshot" TEXT NOT NULL,
  "process_tag_codes_snapshot_json" JSONB NOT NULL DEFAULT '[]',
  "drawing_number_snapshot" TEXT NOT NULL,
  "drawing_version_snapshot" INTEGER NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "quantity" DECIMAL(18, 6) NOT NULL,
  "spare_quantity" DECIMAL(18, 6) NOT NULL DEFAULT 0,
  "required_on" DATE NOT NULL,
  "supplier_reference_id" TEXT,
  "purpose" "DrawingSelectionItemPurpose" NOT NULL,
  "supplier_match_state" "DrawingSelectionItemMatchState" NOT NULL,
  "supplier_exception_reason" TEXT,
  "supplier_capability_snapshot_json" JSONB,
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "drawing_selection_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "drawing_selection_items_category_snapshot_code_check" CHECK (
    "manufacturing_category_code_snapshot" ~ '^[A-Z][A-Z0-9._-]{0,63}$'
  ),
  CONSTRAINT "drawing_selection_items_drawing_number_snapshot_check" CHECK (
    "drawing_number_snapshot" ~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'
  ),
  CONSTRAINT "drawing_selection_items_drawing_version_snapshot_check" CHECK (
    "drawing_version_snapshot" > 0
  ),
  CONSTRAINT "drawing_selection_items_version_check" CHECK ("version" > 0),
  CONSTRAINT "drawing_selection_items_quantity_check" CHECK ("quantity" > 0),
  CONSTRAINT "drawing_selection_items_spare_quantity_check" CHECK ("spare_quantity" >= 0),
  CONSTRAINT "drawing_selection_items_process_tag_snapshot_array_check" CHECK (
    jsonb_typeof("process_tag_codes_snapshot_json") = 'array'
  ),
  CONSTRAINT "drawing_selection_items_supplier_match_check" CHECK (
    (
      "supplier_reference_id" IS NULL
      AND "supplier_match_state" = 'NO_MATCH'
      AND "supplier_exception_reason" IS NULL
      AND "supplier_capability_snapshot_json" IS NULL
    )
    OR (
      "supplier_reference_id" IS NOT NULL
      AND "supplier_match_state" = 'DEFAULT_MATCH'
      AND "supplier_exception_reason" IS NULL
      AND "supplier_capability_snapshot_json" IS NOT NULL
    )
    OR (
      "supplier_reference_id" IS NOT NULL
      AND "supplier_match_state" = 'EXCEPTION'
      AND length(btrim("supplier_exception_reason")) > 0
    )
  )
);

CREATE INDEX "manufacturing_categories_active_sort_order_idx"
  ON "manufacturing_categories"("is_active", "sort_order");
CREATE INDEX "process_tags_active_sort_order_idx"
  ON "process_tags"("is_active", "sort_order");
CREATE UNIQUE INDEX "mechanical_drawing_process_tags_drawing_tag_key"
  ON "mechanical_drawing_process_tags"("drawing_id", "process_tag_id");
CREATE UNIQUE INDEX "mechanical_drawing_process_tags_id_project_id_key"
  ON "mechanical_drawing_process_tags"("id", "project_id");
CREATE INDEX "mechanical_drawing_process_tags_project_drawing_idx"
  ON "mechanical_drawing_process_tags"("project_id", "drawing_id");
CREATE INDEX "mechanical_drawing_process_tags_process_tag_id_idx"
  ON "mechanical_drawing_process_tags"("process_tag_id");
CREATE INDEX "mechanical_drawings_project_category_idx"
  ON "mechanical_drawings"("project_id", "manufacturing_category_id");
CREATE UNIQUE INDEX "supplier_reference_manufacturing_capabilities_supplier_category_key"
  ON "supplier_reference_manufacturing_capabilities"("supplier_reference_id", "manufacturing_category_id");
CREATE UNIQUE INDEX "supplier_reference_manufacturing_capabilities_id_project_id_key"
  ON "supplier_reference_manufacturing_capabilities"("id", "project_id");
CREATE INDEX "supplier_reference_manufacturing_capabilities_project_supplier_active_idx"
  ON "supplier_reference_manufacturing_capabilities"("project_id", "supplier_reference_id", "is_active");
CREATE INDEX "supplier_reference_manufacturing_capabilities_category_active_idx"
  ON "supplier_reference_manufacturing_capabilities"("manufacturing_category_id", "is_active");
CREATE UNIQUE INDEX "supplier_reference_process_capabilities_capability_tag_key"
  ON "supplier_reference_process_capabilities"("supplier_capability_id", "process_tag_id");
CREATE INDEX "supplier_reference_process_capabilities_project_capability_active_idx"
  ON "supplier_reference_process_capabilities"("project_id", "supplier_capability_id", "is_active");
CREATE INDEX "supplier_reference_process_capabilities_tag_active_idx"
  ON "supplier_reference_process_capabilities"("process_tag_id", "is_active");
CREATE UNIQUE INDEX "drawing_selection_sets_project_code_key"
  ON "drawing_selection_sets"("project_id", "code");
CREATE UNIQUE INDEX "drawing_selection_sets_id_project_id_key"
  ON "drawing_selection_sets"("id", "project_id");
CREATE INDEX "drawing_selection_sets_project_status_created_idx"
  ON "drawing_selection_sets"("project_id", "status", "created_at");
CREATE UNIQUE INDEX "drawing_selection_items_set_document_version_key"
  ON "drawing_selection_items"("selection_set_id", "document_version_id");
CREATE UNIQUE INDEX "drawing_selection_items_id_project_id_key"
  ON "drawing_selection_items"("id", "project_id");
CREATE INDEX "drawing_selection_items_project_set_idx"
  ON "drawing_selection_items"("project_id", "selection_set_id");
CREATE INDEX "drawing_selection_items_project_drawing_idx"
  ON "drawing_selection_items"("project_id", "drawing_id");
CREATE INDEX "drawing_selection_items_supplier_reference_id_idx"
  ON "drawing_selection_items"("supplier_reference_id");

ALTER TABLE "mechanical_drawings"
  ADD CONSTRAINT "mechanical_drawings_manufacturing_category_fkey"
    FOREIGN KEY ("manufacturing_category_id") REFERENCES "manufacturing_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "mechanical_drawing_process_tags"
  ADD CONSTRAINT "mechanical_drawing_process_tags_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "mechanical_drawing_process_tags_drawing_project_fkey"
    FOREIGN KEY ("drawing_id", "project_id") REFERENCES "mechanical_drawings"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "mechanical_drawing_process_tags_process_tag_fkey"
    FOREIGN KEY ("process_tag_id") REFERENCES "process_tags"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_reference_manufacturing_capabilities"
  ADD CONSTRAINT "supplier_reference_manufacturing_capabilities_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "supplier_reference_manufacturing_capabilities_supplier_project_fkey"
    FOREIGN KEY ("supplier_reference_id", "project_id") REFERENCES "supplier_references"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "supplier_reference_manufacturing_capabilities_category_fkey"
    FOREIGN KEY ("manufacturing_category_id") REFERENCES "manufacturing_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_reference_process_capabilities"
  ADD CONSTRAINT "supplier_reference_process_capabilities_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "supplier_reference_process_capabilities_capability_project_fkey"
    FOREIGN KEY ("supplier_capability_id", "project_id") REFERENCES "supplier_reference_manufacturing_capabilities"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "supplier_reference_process_capabilities_process_tag_fkey"
    FOREIGN KEY ("process_tag_id") REFERENCES "process_tags"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "drawing_selection_sets"
  ADD CONSTRAINT "drawing_selection_sets_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "drawing_selection_sets_created_by_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "drawing_selection_items"
  ADD CONSTRAINT "drawing_selection_items_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "drawing_selection_items_selection_set_project_fkey"
    FOREIGN KEY ("selection_set_id", "project_id") REFERENCES "drawing_selection_sets"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "drawing_selection_items_drawing_project_fkey"
    FOREIGN KEY ("drawing_id", "project_id") REFERENCES "mechanical_drawings"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "drawing_selection_items_document_version_project_fkey"
    FOREIGN KEY ("document_version_id", "project_id") REFERENCES "controlled_document_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "drawing_selection_items_category_snapshot_fkey"
    FOREIGN KEY ("manufacturing_category_code_snapshot") REFERENCES "manufacturing_categories"("code") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "drawing_selection_items_supplier_reference_project_fkey"
    FOREIGN KEY ("supplier_reference_id", "project_id") REFERENCES "supplier_references"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "drawing_selection_items_created_by_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "manufacturing_categories" ("id", "code", "name", "sort_order", "is_active", "version", "updated_at")
VALUES
  ('apm053-category-machining', 'MACHINING', 'Machining', 1, true, 1, CURRENT_TIMESTAMP),
  ('apm053-category-sheet-metal', 'SHEET_METAL', 'Sheet metal', 2, true, 1, CURRENT_TIMESTAMP),
  ('apm053-category-welded-structure', 'WELDED_STRUCTURE', 'Welded structure', 3, true, 1, CURRENT_TIMESTAMP),
  ('apm053-category-surface-treatment', 'SURFACE_TREATMENT', 'Surface treatment', 4, true, 1, CURRENT_TIMESTAMP),
  ('apm053-category-additive-manufacturing', 'ADDITIVE_MANUFACTURING', '3D printing / rapid manufacturing', 5, true, 1, CURRENT_TIMESTAMP),
  ('apm053-category-other-outsourcing', 'OTHER_OUTSOURCING', 'Other outsourcing', 6, true, 1, CURRENT_TIMESTAMP),
  ('apm053-category-not-externally-manufactured', 'NOT_EXTERNALLY_MANUFACTURED', 'Not externally manufactured', 7, true, 1, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "process_tags" ("id", "code", "name", "sort_order", "is_active", "version", "updated_at")
VALUES
  ('apm053-process-turning', 'TURNING', 'Turning', 1, true, 1, CURRENT_TIMESTAMP),
  ('apm053-process-milling', 'MILLING', 'Milling', 2, true, 1, CURRENT_TIMESTAMP),
  ('apm053-process-grinding', 'GRINDING', 'Grinding', 3, true, 1, CURRENT_TIMESTAMP),
  ('apm053-process-wire-edm', 'WIRE_EDM', 'Wire EDM', 4, true, 1, CURRENT_TIMESTAMP),
  ('apm053-process-laser-cutting', 'LASER_CUTTING', 'Laser cutting', 5, true, 1, CURRENT_TIMESTAMP),
  ('apm053-process-bending', 'BENDING', 'Bending', 6, true, 1, CURRENT_TIMESTAMP),
  ('apm053-process-welding', 'WELDING', 'Welding', 7, true, 1, CURRENT_TIMESTAMP),
  ('apm053-process-heat-treatment', 'HEAT_TREATMENT', 'Heat treatment', 8, true, 1, CURRENT_TIMESTAMP),
  ('apm053-process-anodizing', 'ANODIZING', 'Anodizing', 9, true, 1, CURRENT_TIMESTAMP),
  ('apm053-process-coating', 'COATING', 'Coating', 10, true, 1, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

CREATE FUNCTION validate_manufacturing_configuration_mutation() RETURNS trigger AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."code" IS DISTINCT FROM OLD."code"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'manufacturing configuration identity is immutable and commands advance version once'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_manufacturing_configuration_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'manufacturing configuration facts must be disabled instead of removed'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_active_manufacturing_category_assignment() RETURNS trigger AS $$
DECLARE
  category_active BOOLEAN;
BEGIN
  IF NEW."manufacturing_category_id" IS NULL THEN
    IF TG_OP = 'INSERT' OR OLD."manufacturing_category_id" IS NOT NULL THEN
      RAISE EXCEPTION 'mechanical drawings require a manufacturing category'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
    AND NEW."manufacturing_category_id" IS NOT DISTINCT FROM OLD."manufacturing_category_id" THEN
    RETURN NEW;
  END IF;
  SELECT "is_active" INTO category_active
    FROM "manufacturing_categories"
    WHERE "id" = NEW."manufacturing_category_id";
  IF category_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'new drawing classifications require an active manufacturing category'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_active_drawing_process_tag_assignment() RETURNS trigger AS $$
DECLARE
  process_tag_active BOOLEAN;
BEGIN
  SELECT "is_active" INTO process_tag_active
    FROM "process_tags"
    WHERE "id" = NEW."process_tag_id";
  IF process_tag_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'new drawing classifications require active process tags'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_supplier_manufacturing_capability() RETURNS trigger AS $$
DECLARE
  category_active BOOLEAN;
BEGIN
  SELECT "is_active" INTO category_active
    FROM "manufacturing_categories"
    WHERE "id" = NEW."manufacturing_category_id";
  IF category_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'supplier capabilities require an active manufacturing category'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_supplier_manufacturing_capability_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'supplier manufacturing capabilities must be disabled instead of removed'
      USING ERRCODE = '55000';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
    OR NEW."supplier_reference_id" IS DISTINCT FROM OLD."supplier_reference_id"
    OR NEW."manufacturing_category_id" IS DISTINCT FROM OLD."manufacturing_category_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'supplier manufacturing capability identity is immutable and commands advance version once'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_supplier_process_capability() RETURNS trigger AS $$
DECLARE
  process_tag_active BOOLEAN;
BEGIN
  SELECT "is_active" INTO process_tag_active
    FROM "process_tags"
    WHERE "id" = NEW."process_tag_id";
  IF process_tag_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'supplier process capabilities require an active process tag'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_supplier_process_capability_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'supplier process capabilities must be disabled instead of removed'
      USING ERRCODE = '55000';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
    OR NEW."supplier_capability_id" IS DISTINCT FROM OLD."supplier_capability_id"
    OR NEW."process_tag_id" IS DISTINCT FROM OLD."process_tag_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'supplier process capability identity is immutable and commands advance version once'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_drawing_selection_set_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" = 'LOCKED'::"DrawingSelectionSetStatus" THEN
      RAISE EXCEPTION 'locked drawing selection sets are immutable' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" = 'LOCKED'::"DrawingSelectionSetStatus" THEN
    RAISE EXCEPTION 'locked drawing selection sets are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
    OR NEW."code" IS DISTINCT FROM OLD."code"
    OR NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'drawing selection set identity is immutable and commands advance version once'
      USING ERRCODE = '55000';
  END IF;
  IF NEW."status" NOT IN ('DRAFT'::"DrawingSelectionSetStatus", 'LOCKED'::"DrawingSelectionSetStatus") THEN
    RAISE EXCEPTION 'drawing selection set transition is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_drawing_selection_item() RETURNS trigger AS $$
DECLARE
  selection_status "DrawingSelectionSetStatus";
  drawing_document_id TEXT;
  drawing_category_code TEXT;
  drawing_number TEXT;
  drawing_version_document_id TEXT;
  drawing_version_status "ControlledDocumentVersionStatus";
  drawing_version_number INTEGER;
  retained_file_count INTEGER;
  invalid_file_count INTEGER;
  cad_source_file_count INTEGER;
  drawing_process_tag_codes JSONB;
  snapshot_tag JSONB;
  snapshot_tag_code TEXT;
  previous_snapshot_tag_code TEXT;
BEGIN
  SELECT "status" INTO selection_status
    FROM "drawing_selection_sets"
    WHERE "id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."selection_set_id" ELSE NEW."selection_set_id" END
      AND "project_id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."project_id" ELSE NEW."project_id" END
    FOR UPDATE;
  IF selection_status IS DISTINCT FROM 'DRAFT'::"DrawingSelectionSetStatus" THEN
    RAISE EXCEPTION 'locked drawing selection items are immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
      OR NEW."selection_set_id" IS DISTINCT FROM OLD."selection_set_id"
      OR NEW."drawing_id" IS DISTINCT FROM OLD."drawing_id"
      OR NEW."document_version_id" IS DISTINCT FROM OLD."document_version_id"
      OR NEW."manufacturing_category_code_snapshot" IS DISTINCT FROM OLD."manufacturing_category_code_snapshot"
      OR NEW."process_tag_codes_snapshot_json" IS DISTINCT FROM OLD."process_tag_codes_snapshot_json"
      OR NEW."drawing_number_snapshot" IS DISTINCT FROM OLD."drawing_number_snapshot"
      OR NEW."drawing_version_snapshot" IS DISTINCT FROM OLD."drawing_version_snapshot"
      OR NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id"
      OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
      OR NEW."version" <> OLD."version" + 1 THEN
      RAISE EXCEPTION 'drawing selection item snapshots are immutable and commands advance version once'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  SELECT drawing."document_id", category."code", drawing."drawing_number"
    INTO drawing_document_id, drawing_category_code, drawing_number
    FROM "mechanical_drawings" AS drawing
    LEFT JOIN "manufacturing_categories" AS category
      ON category."id" = drawing."manufacturing_category_id"
    WHERE drawing."id" = NEW."drawing_id"
      AND drawing."project_id" = NEW."project_id";
  IF drawing_category_code IS NULL THEN
    RAISE EXCEPTION 'drawing selection item requires a classified drawing' USING ERRCODE = '23514';
  END IF;
  IF drawing_category_code IS DISTINCT FROM NEW."manufacturing_category_code_snapshot"
    OR drawing_number IS DISTINCT FROM NEW."drawing_number_snapshot" THEN
    RAISE EXCEPTION 'drawing selection item snapshots must match the drawing classification'
      USING ERRCODE = '23514';
  END IF;

  SELECT "document_id", "status", "version"
    INTO drawing_version_document_id, drawing_version_status, drawing_version_number
    FROM "controlled_document_versions"
    WHERE "id" = NEW."document_version_id"
      AND "project_id" = NEW."project_id";
  IF drawing_version_document_id IS DISTINCT FROM drawing_document_id
    OR drawing_version_status IS DISTINCT FROM 'PUBLISHED'::"ControlledDocumentVersionStatus"
    OR drawing_version_number IS DISTINCT FROM NEW."drawing_version_snapshot" THEN
    RAISE EXCEPTION 'drawing selection item must reference an exact published drawing version'
      USING ERRCODE = '23514';
  END IF;

  IF jsonb_typeof(NEW."process_tag_codes_snapshot_json") IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'drawing selection item process tag snapshot must be an array' USING ERRCODE = '23514';
  END IF;
  previous_snapshot_tag_code := NULL;
  FOR snapshot_tag IN SELECT value FROM jsonb_array_elements(NEW."process_tag_codes_snapshot_json")
  LOOP
    snapshot_tag_code := snapshot_tag #>> '{}';
    IF jsonb_typeof(snapshot_tag) IS DISTINCT FROM 'string'
      OR snapshot_tag_code !~ '^[A-Z][A-Z0-9._-]{0,63}$'
      OR (previous_snapshot_tag_code IS NOT NULL AND previous_snapshot_tag_code >= snapshot_tag_code) THEN
      RAISE EXCEPTION 'drawing selection item process tag snapshot must be sorted and unique'
        USING ERRCODE = '23514';
    END IF;
    previous_snapshot_tag_code := snapshot_tag_code;
  END LOOP;
  SELECT COALESCE(jsonb_agg(tag."code" ORDER BY tag."code"), '[]'::jsonb)
    INTO drawing_process_tag_codes
    FROM "mechanical_drawing_process_tags" AS drawing_tag
    INNER JOIN "process_tags" AS tag ON tag."id" = drawing_tag."process_tag_id"
    WHERE drawing_tag."drawing_id" = NEW."drawing_id"
      AND drawing_tag."project_id" = NEW."project_id";
  IF drawing_process_tag_codes IS DISTINCT FROM NEW."process_tag_codes_snapshot_json" THEN
    RAISE EXCEPTION 'drawing selection item process tag snapshot must match drawing classification'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO retained_file_count
    FROM "mechanical_drawing_version_files"
    WHERE "drawing_id" = NEW."drawing_id"
      AND "document_version_id" = NEW."document_version_id"
      AND "project_id" = NEW."project_id";
  IF retained_file_count = 0 THEN
    RAISE EXCEPTION 'drawing selection item requires scanned controlled drawing files'
      USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO invalid_file_count
    FROM "mechanical_drawing_version_files" AS drawing_file
    INNER JOIN "file_objects" AS file_object
      ON file_object."id" = drawing_file."file_id"
      AND file_object."project_id" = drawing_file."project_id"
    WHERE drawing_file."drawing_id" = NEW."drawing_id"
      AND drawing_file."document_version_id" = NEW."document_version_id"
      AND drawing_file."project_id" = NEW."project_id"
      AND (
        file_object."status" IS DISTINCT FROM 'AVAILABLE'::"FileObjectStatus"
        OR file_object."storage_area" IS DISTINCT FROM 'CONTROLLED'::"FileStorageArea"
        OR file_object."scanned_at" IS NULL
        OR file_object."sha256" IS NULL
        OR file_object."verified_mime_type" IS NULL
        OR file_object."verified_size" IS NULL
      );
  IF invalid_file_count > 0 THEN
    RAISE EXCEPTION 'drawing selection item requires scanned controlled drawing files'
      USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO cad_source_file_count
    FROM "mechanical_drawing_version_files"
    WHERE "drawing_id" = NEW."drawing_id"
      AND "document_version_id" = NEW."document_version_id"
      AND "project_id" = NEW."project_id"
      AND "role" = 'CAD_SOURCE'::"DrawingFileRole";
  IF cad_source_file_count <> 1 THEN
    RAISE EXCEPTION 'drawing selection item requires exactly one CAD source file'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_drawing_selection_history_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'drawing selection facts must be retained instead of removed'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER manufacturing_categories_validate_mutation
  BEFORE UPDATE ON "manufacturing_categories"
  FOR EACH ROW EXECUTE FUNCTION validate_manufacturing_configuration_mutation();
CREATE TRIGGER manufacturing_categories_reject_delete
  BEFORE DELETE ON "manufacturing_categories"
  FOR EACH ROW EXECUTE FUNCTION reject_manufacturing_configuration_delete();
CREATE TRIGGER manufacturing_categories_reject_truncate
  BEFORE TRUNCATE ON "manufacturing_categories"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_manufacturing_configuration_delete();
CREATE TRIGGER process_tags_validate_mutation
  BEFORE UPDATE ON "process_tags"
  FOR EACH ROW EXECUTE FUNCTION validate_manufacturing_configuration_mutation();
CREATE TRIGGER process_tags_reject_delete
  BEFORE DELETE ON "process_tags"
  FOR EACH ROW EXECUTE FUNCTION reject_manufacturing_configuration_delete();
CREATE TRIGGER process_tags_reject_truncate
  BEFORE TRUNCATE ON "process_tags"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_manufacturing_configuration_delete();
CREATE TRIGGER mechanical_drawings_validate_manufacturing_category
  BEFORE INSERT OR UPDATE ON "mechanical_drawings"
  FOR EACH ROW EXECUTE FUNCTION validate_active_manufacturing_category_assignment();
CREATE TRIGGER mechanical_drawing_process_tags_validate_active_tag
  BEFORE INSERT OR UPDATE OF "process_tag_id" ON "mechanical_drawing_process_tags"
  FOR EACH ROW EXECUTE FUNCTION validate_active_drawing_process_tag_assignment();
CREATE TRIGGER supplier_reference_manufacturing_capabilities_validate_active_category
  BEFORE INSERT OR UPDATE OF "manufacturing_category_id" ON "supplier_reference_manufacturing_capabilities"
  FOR EACH ROW EXECUTE FUNCTION validate_supplier_manufacturing_capability();
CREATE TRIGGER supplier_reference_manufacturing_capabilities_validate_mutation
  BEFORE UPDATE OR DELETE ON "supplier_reference_manufacturing_capabilities"
  FOR EACH ROW EXECUTE FUNCTION validate_supplier_manufacturing_capability_mutation();
CREATE TRIGGER supplier_reference_manufacturing_capabilities_reject_truncate
  BEFORE TRUNCATE ON "supplier_reference_manufacturing_capabilities"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_manufacturing_configuration_delete();
CREATE TRIGGER supplier_reference_process_capabilities_validate_active_tag
  BEFORE INSERT OR UPDATE OF "process_tag_id" ON "supplier_reference_process_capabilities"
  FOR EACH ROW EXECUTE FUNCTION validate_supplier_process_capability();
CREATE TRIGGER supplier_reference_process_capabilities_validate_mutation
  BEFORE UPDATE OR DELETE ON "supplier_reference_process_capabilities"
  FOR EACH ROW EXECUTE FUNCTION validate_supplier_process_capability_mutation();
CREATE TRIGGER supplier_reference_process_capabilities_reject_truncate
  BEFORE TRUNCATE ON "supplier_reference_process_capabilities"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_manufacturing_configuration_delete();
CREATE TRIGGER drawing_selection_sets_validate_mutation
  BEFORE UPDATE OR DELETE ON "drawing_selection_sets"
  FOR EACH ROW EXECUTE FUNCTION validate_drawing_selection_set_mutation();
CREATE TRIGGER drawing_selection_sets_reject_truncate
  BEFORE TRUNCATE ON "drawing_selection_sets"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_drawing_selection_history_truncate();
CREATE TRIGGER drawing_selection_items_validate
  BEFORE INSERT OR UPDATE OR DELETE ON "drawing_selection_items"
  FOR EACH ROW EXECUTE FUNCTION validate_drawing_selection_item();
CREATE TRIGGER drawing_selection_items_reject_truncate
  BEFORE TRUNCATE ON "drawing_selection_items"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_drawing_selection_history_truncate();
