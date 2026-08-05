# APM-052 Mechanical Drawings Design

## Goal

Add project mechanical drawings without introducing a second document-version lifecycle. A drawing has one stable drawing number, extends a controlled document, and records the exact CAD, PDF, and optional STEP files used by each document version.

## Boundaries

- APM-052 owns drawing identity, drawing type, drawing-version file roles, filename pairing, import candidates, confirmation, and the drawing APIs.
- APM-050 continues to own draft, publication, supersession, voiding, file availability, source hashes, and current-published-version invariants.
- Manufacturing category, process tags, supplier capability, selection, RFQ, and package quantities remain exclusively in APM-053 and later packages.

## Data model

`MechanicalDrawing` is one-to-one with `ControlledDocument` in the same project. `drawingNumber` is normalized with the existing controlled-document code rule and must equal the linked document code, so the project-scoped drawing-number unique key has a database invariant.

`MechanicalDrawingVersionFile` points to an exact controlled-document version and a scanned, available file in the same project. It records one role per version: `CAD_SOURCE`, `PDF_PREVIEW`, or `STEP_EXCHANGE`. The controlled-document source file remains the CAD source; the PDF and STEP files are explicit, immutable version attachments.

`MechanicalDrawingImportBatch` and its items are temporary-but-audited import facts. Filename recognition groups only identical normalized filename stems. It never silently creates drawings: a manager confirms each accepted item and supplies/accepts its drawing number, title, and drawing type. Files that are absent, foreign, or unscanned are rejected before candidate creation or confirmation.

## Commands and security

The drawing endpoints use the existing `CONTROLLED_DOCUMENT_READ` and `CONTROLLED_DOCUMENT_MANAGE` permissions. Create, new-version, and bulk-confirm commands require an idempotency key; new-version and confirmation require the drawing resource version. Each command performs business writes, success audit, and Outbox append in one Prisma transaction. Reads never return a drawing whose source/attachment is a restricted file to an actor lacking `SENSITIVE_FILE_READ`.

## Acceptance cases

1. The same drawing number cannot be created twice in a project, but can exist in different projects.
2. A drawing version retains exact file IDs and SHA-256 snapshots; publishing a later version cannot rewrite the earlier one.
3. CAD/PDF candidates with the same filename stem are paired, while unmatched files remain visible for manual confirmation.
4. Import confirmation is idempotent, rejects cross-project/unscanned files and stale drawing state, and writes audit plus Outbox facts.
5. Manufacturing classification, quantities, supplier fields, and supplier package behavior are absent from the schema and DTOs.
