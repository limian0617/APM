# APM Engineering Foundation

The repository contains the foundation for the Automation Project Management system.
The product scope and delivery sequence are defined in the planning artifacts under
`D:\GPT Prj\自动化设备项目管理`.

## Local development

1. Copy `.env.example` to `.env` and set local values.
2. Start PostgreSQL with `docker compose up -d`.
3. Install packages with `npm install`.
4. Generate the Prisma client with `npm run db:generate`.
5. Start the application with `npm run dev`.

## Verification

Run the following before handing off a change:

```powershell
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run db:generate
npm run db:validate
npm run build
```

## APM-002 authorization

APM-002 adds users, system roles, permission scopes, project membership, object-level
authorization, and authorization-denial audits. The default MVP role matrix is installed by
`20260802010000_apm_002_authorization`.

Authentication is still an external IT decision. Until an identity provider is selected, API
requests use the provisional `x-apm-user-id` trusted-upstream header. Production additionally
requires `x-apm-auth-secret` to match `AUTH_TRUSTED_HEADER_SECRET`; the reverse proxy must strip
client-supplied copies of both headers.

Project member endpoints:

- `GET /api/projects/{projectId}/members` requires project-member read access.
- `POST /api/projects/{projectId}/members` requires member-management access and a
  `projectVersion` in the JSON body.
- `DELETE /api/projects/{projectId}/members/{membershipId}` requires member-management access and
  the current project version in `If-Match`.

Member removal is a recorded exit (`leftAt`/`leftById`), never a physical delete. A project must
retain at least one active project manager.

## Current scope

APM-001 establishes the runtime, quality checks, database tooling, local PostgreSQL, service
health endpoint, and CI. APM-002 establishes the authorization foundation and project-member
boundary. Template snapshots and the remaining project domain start with later work packages.
