# APM-053 Manufacturing Classification, Process Tags, Supplier Capability, and Drawing Selection Design

## Goal

Add a controlled internal workflow that classifies mechanical drawings, records project-scoped supplier manufacturing capabilities, and creates auditable drawing selection sets from exact published drawing versions. The workflow supports internal inquiry, manufacturing, change, and reference preparation only; it does not publish anything externally.

## Scope and Dependencies

APM-053 extends APM-052 mechanical drawings and the project-scoped `SupplierReference` boundary from APM-090. It relies on the existing controlled-document publication lifecycle, FileObject scan lifecycle, project authorization guard, optimistic versions, HTTP idempotency records, append-only audit, and transactional Outbox.

This package does not implement APM-024 plan changes, APM-054 drawing import expansion, APM-104, APM-110 external supplier identities, APM-111 immutable RFQ revisions, APM-112 supplier portal actions, quotation, confirmation, external download, ERP supplier master data, ERP inventory, BOM/MRP, procurement finance, or NUS-M9 production integration.

## Vocabulary and Configuration

`ManufacturingCategory` is a global configuration resource with an immutable stable `code`, display name, sort order, and active flag. The migration seeds exactly these active default codes:

| Code                        | Display name                      |
| --------------------------- | --------------------------------- |
| MACHINING                   | Machining                         |
| SHEET_METAL                 | Sheet metal                       |
| WELDED_STRUCTURE            | Welded structure                  |
| SURFACE_TREATMENT           | Surface treatment                 |
| ADDITIVE_MANUFACTURING      | 3D printing / rapid manufacturing |
| OTHER_OUTSOURCING           | Other outsourcing                 |
| NOT_EXTERNALLY_MANUFACTURED | Not externally manufactured       |

`ProcessTag` is a separate global configuration resource with stable code, display name, sort order, and active flag. Initial tags cover the PRD examples: turning, milling, grinding, wire EDM, laser cutting, bending, welding, heat treatment, anodizing, and coating. A category or tag is disabled rather than physically deleted. Existing drawing, supplier-capability, and selection-item references stay readable after deactivation.

Configuration creation, update, enable, and disable require `CONFIGURATION_WRITE`. Stable codes are never renamed or reused. Disabling a value prevents new assignments but does not mutate historical references.

## Domain Model

`MechanicalDrawing` receives one nullable-to-required-after-backfill `manufacturingCategoryId` relation. `drawingType` stays unchanged and remains a separate dimension. `MechanicalDrawingProcessTag` is an explicit many-to-many relation between a drawing and active process tags. A drawing may hold several distinct tags and exactly one primary category. The classification is current drawing-master metadata; every selection item stores a classification snapshot so later classification changes do not rewrite an existing selection.

`SupplierReferenceManufacturingCapability` belongs to an existing project-scoped `SupplierReference`, references one category, and can carry zero or more `SupplierReferenceProcessCapability` rows. A supplier capability with no process-tag rows means it can perform the category without a process-specific assertion. Capability records have their own optimistic version and an active flag; historical selection snapshots preserve what was matched at creation time.

`DrawingSelectionSet` is an internal project aggregate with a stable code, title, `DRAFT` or `LOCKED` status, optimistic version, creator, and timestamps. `DrawingSelectionItem` belongs to a selection set and stores:

- the project, drawing, and exact `ControlledDocumentVersion` IDs;
- the exact drawing number/version and manufacturing category/process-tag snapshots used for matching;
- `quantity`, `spareQuantity`, `requiredOn`, `supplierReferenceId`, `purpose`, and optional exception reason;
- matched-capability snapshot and creation metadata.

The permitted item purposes are `INQUIRY`, `MANUFACTURING`, `CHANGE`, and `REFERENCE`. Quantity, spare quantity, required date, supplier, and purpose are deliberately absent from `MechanicalDrawing`; they only exist on `DrawingSelectionItem`.

`DRAFT` sets can be assembled and edited with optimistic locking. `LOCKED` sets are immutable. A correction creates a separate draft selection set instead of overwriting a locked internal preparation fact. The package does not create external supplier packages or RFQ revisions.

## Validation and Matching

Adding an item validates every relation server-side in the same project. The target drawing must reference the target exact controlled-document version, the version must be `PUBLISHED`, and every retained drawing-version file must be a scanned `AVAILABLE` file in controlled storage. A missing required CAD source, a quarantined/failed/unscanned file, an unpublished version, a different drawing, or a cross-project ID is rejected.

The service determines default candidates from the item’s category and process-tag snapshots. A supplier is a default match only when it has an active capability for the category and covers every selected process tag. A zero-tag drawing only requires the category capability. A set item may select one of those matching suppliers without an exception. Selecting an active same-project supplier that does not match requires a non-empty exception reason; the exception, chosen supplier, required capabilities, and reason are audit and Outbox facts. Selecting a supplier from another project is always rejected. If no supplier matches, the item remains valid with an explicit `NO_MATCH` result and cannot silently invent a supplier.

## Authorization, Concurrency, and Audit

Read routes require `CONTROLLED_DOCUMENT_READ` for drawings/selections and `PROJECT_PROCUREMENT_READ` for supplier capabilities/matches. Drawing classification uses `CONTROLLED_DOCUMENT_MANAGE`. Supplier capability and selection-set writes use `PROJECT_PROCUREMENT_TRACKING_MANAGE`; configuration writes use `CONFIGURATION_WRITE`. Every route also uses the existing project-member guard and object relation checks. Menu visibility is not an authorization boundary.

All writes require an idempotency key. Mutating existing drawings, capability records, selection sets, and selection items requires the relevant current `version`; stale versions return `409`. The service locks the selection aggregate before item writes and locks a capability record before mutations. Each successful business mutation, audit fact, and Outbox event commits in one Prisma transaction. A rejected relation, conflict, or validation failure creates no success audit or Outbox record. Existing idempotency semantics replay equal requests and reject key reuse with a different payload.

## API and UI

Internal APIs remain thin Route Handlers: authenticate/authorize, parse strict DTOs, call an application service, and map known domain failures. API output returns resource version, allowed actions, current category/tag state, supplier match status, and explicit empty/restricted/error states without disclosing inaccessible data.

The project drawing workspace provides two practical panels:

1. **Drawing classification** lists only authorized drawings, shows type separately from manufacturing category, and lets authorized users set the one category and multi-select active tags.
2. **Drawing selections** creates a draft selection set, adds exact published drawing versions, shows default supplier matches or an explicit no-match state, records an authorized exception reason, and locks the set after review.

The desktop layout uses dense lists, table rows, status bands, and forms consistent with existing execution/procurement pages. At 390px, navigation and tables remain discoverable, forms stack without horizontal page overflow, status is written as text rather than color alone, and every command has keyboard focus treatment. The page represents normal, loading, empty, retryable error, denied, stale, conflict, and no-match states; it does not use a simulated-success page.

## Test Strategy

Test-first coverage includes pure code normalization and category/tag selection rules; DTO rejection; exact-version, published, scan, storage-area, and project checks; disabled historical references; default machining/sheet-metal matches; exception reason requirements; no-match; IDOR; authorization; stale version conflicts; idempotent replay/key reuse; audit/Outbox transaction rollback; PostgreSQL uniqueness, foreign keys, and locked-set immutability; and real route-to-page contract tests.

PostgreSQL verification runs an empty database through all migrations and an upgraded APM-103 database through the APM-053 migration when PostgreSQL is available. Browser verification covers 1440x900 and 390x844 for the required states and workflows. The external progress tracker is updated only after local gates and GitHub CI prove the work package accepted.

## Design Self-Review

The design keeps drawing type independent from manufacturing classification, avoids overloading `SupplierReference.capabilityTagsJson`, snapshots mutable classification facts at selection time, and has no external-package, quotation, ERP, or portal behavior. No unresolved placeholder or pending business decision remains within APM-053.
