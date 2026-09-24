# Claude responsibility audit

**Scope:** Every repository assignment involving Claude, Anthropic, or “engineer your code.” Claude is a development-process actor, not a product feature.

**Audited commit:** `184380a162525185205277c0c887c83a6e7035d0` on `main` (2026-09-23).

**Search performed:** repository-wide for `Claude`, `Anthropic`, `engineer your code`, `SOP`, `agent`, `review`, `verification`, `audit`, `handoff`, `implementation responsibility`, `AI`.

## Classification key

| Kind | Meaning |
| --- | --- |
| Product requirement | Would change owner/customer/staff software |
| Engineering-process requirement | SOP/contract duty for a coding agent or human |
| Claude-specific assignment | Named to Claude Code |
| Cursor/other-agent assignment | Named to Cursor or generic Agent |
| Human/manual | Founder, counsel, staff, store, ops |
| External-provider | Apple, RevenueCat, Resend, Supabase, Render |
| Explanatory copy | Describes process; does not assign a task |
| Placeholder/accidental UI | User-visible text without backing behavior |
| Anthropic integration | Would send application data to Anthropic APIs |

## 1. Phrase “Claude will engineer your code”

**No occurrence** of `engineer your code`, `Claude will engineer`, or similar product copy exists in application UI, i18n, portal, admin, or docs.

Nothing user-facing promises that Claude writes or reviews the operator’s code at runtime.

## 2. Anthropic API integration

| Check | Result |
| --- | --- |
| Anthropic SDK / API client in package manifests | None |
| `ANTHROPIC` env keys in `.env.example` / `docs/ENV.md` | None |
| Mobile/client secrets for Anthropic | None (no integration) |
| Application data sent to Claude/Anthropic | None |
| Privacy/consent/retention for model training on app data | **Not applicable** — no send path |

DEC11 (no custom AI, autonomous pricing, image interpretation, or generative terms) is a product rule. Keyboard dictation remains allowed. No Claude-in-product feature is required or implemented.

## 3. Standing instruction files

### 3.1 `CLAUDE.md` (repository root)

Quote (summary): Claude is the senior technical reviewer. Always read `ENGINEERING_CONTRACT.md`. `docs/PRD.md` is authoritative. Responsibilities: architecture analysis, complex debugging, security review, code review, PRD completeness review, adversarial QA. Do not rewrite working code unnecessarily. When reviewing, assume Cursor work may contain subtle failures. Verify claims against code and tests. Classify BLOCKER/HIGH/MEDIUM/LOW. When asked to review rather than implement, do not modify files unless instructed.

| Field | Value |
| --- | --- |
| Responsibility | Standing reviewer brief |
| Type | Engineering-process / Claude-specific |
| Evidence Claude performed it | File exists. No dated review report from a Claude session is stored in-repo |
| Status | **Incomplete / unverified** as an executed review program |
| Still required | Produce dated §16/§39/§41/§42 review artifacts, or record that a named human accepted this Cursor audit as the §42 substitute |

Source of the text: SOP §9 “Claude instructions.”

### 3.2 SOP §3 — Cursor vs Claude roles

Quote: “Cursor = Primary Builder” (80–90% of implementation). “Claude Code = Senior Engineer / Red Team.” Use Claude for initial architecture review, security review, database/RLS review, subscription/payment review, investigating problems Cursor repeatedly fails to solve. Claude should review or solve difficult problems rather than continuously rewrite Cursor’s work.

| Field | Value |
| --- | --- |
| Type | Engineering-process |
| Evidence | Implementation history is Cursor-shaped. No Claude review artifacts |
| Status | Role defined; Claude execution **unverified** |

### 3.3 SOP §8 / `ENGINEERING_CONTRACT.md`

Both Cursor and Claude must obey the contract. Contract is present. Cursor rules reference it. Claude obeys it only when a Claude session is run with that file.

Status: **instruction present**; execution unverified for Claude sessions.

### 3.4 SOP §9 Claude operating mode

Never run Claude Code with unrestricted destructive permissions as the normal default. Claude may perform routine safe operations per approved permissions.

Status: **process rule**. No evidence of a Claude session with destructive defaults in this repo. Not applicable to this Cursor audit (no product mutation).

## 4. Named Claude assignments (SOP)

### CLAUDE.SOP16 — Architecture review before major implementation

**Source:** `docs/SOP.md` §16.

**Instruction:** Before major implementation, Claude performs one read-only review of ENGINEERING_CONTRACT, PRD, IMPLEMENTATION_PLAN, ARCHITECTURE, DATABASE, REQUIREMENTS_MATRIX. Do not write code. Classify BLOCKER/HIGH/MEDIUM/LOW. Fix BLOCKER/HIGH planning issues before implementation.

| Field | Value |
| --- | --- |
| Class | Review / planning |
| Evidence | `docs/IMPLEMENTATION_PLAN.md` exists. No `docs/audits/` or other Claude architecture-review report predating Stage 1–4 slices |
| Status | **Incomplete** |
| Remaining | A Claude (or accepted substitute) read-only architecture review dated against the current plan, or a written waiver by the engineering lead |

### CLAUDE.SOP39 — Adversarial code review

**Source:** `docs/SOP.md` §39.

**Instruction:** Run Claude Code in review mode. Prove the application is not ready. Inspect actual implementation. Do not trust comments. Classify findings with evidence, files, reproduction, fix, and regression test.

| Field | Value |
| --- | --- |
| Class | Review |
| Evidence | This Cursor audit overlaps the objective but is not a Claude Code session. No prior §39 report in-repo |
| Status | **Incomplete** (this document is a Cursor audit, not Claude Code §39) |
| Remaining | Dedicated Claude Code review pass, or explicit human acceptance that this audit substitutes |

### CLAUDE.SOP41 — Security audit

**Source:** `docs/SOP.md` §41.

**Instruction:** Hostile security review of authn, authz, RLS, secrets, API keys, Edge Functions, file permissions, user input, deletion, subscriptions, deep links, sensitive logs. Assume attacker controls the client.

| Field | Value |
| --- | --- |
| Class | Review / security |
| Evidence | Local RLS tests and secret-scan exist. No Claude hostile-review report. Hosted two-tenant isolation unverified |
| Status | **Incomplete** |
| Remaining | Claude (or specialist) hostile review after staff-auth and hosted commercial migrations exist |

### CLAUDE.SOP42 — PRD compliance audit (mandatory)

**Source:** `docs/SOP.md` §42.

**Instruction:** Give Claude the original PRD. Requirement-by-requirement audit. Classify VERIFIED / PARTIALLY IMPLEMENTED / NOT IMPLEMENTED / CANNOT VERIFY. Do not mark VERIFIED because a screen/function/comment/mocked test exists. Update REQUIREMENTS_MATRIX.md. Release requires all material PRD requirements VERIFIED.

| Field | Value |
| --- | --- |
| Class | Review / verification / documentation |
| Evidence | This Cursor session produced `docs/audits/*` per the user’s audit-only brief. Status vocabulary differs (eight statuses). `REQUIREMENTS_MATRIX.md` was **not** updated (user forbid edits outside `docs/audits/`) |
| Status | **Partially complete as a Cursor substitute; incomplete vs SOP letter** |
| Remaining | (1) Human decide whether this audit satisfies §42. (2) Later update the matrix. (3) Optional Claude re-audit |

### CLAUDE.SOP43 — Verify Cursor BLOCKER/HIGH fixes

**Source:** `docs/SOP.md` §43.

**Instruction:** After Cursor fixes Claude’s BLOCKER/HIGH findings, Claude verifies fixes rather than trusting Cursor’s claims.

| Field | Value |
| --- | --- |
| Class | Verification |
| Evidence | No Claude finding list exists to verify against |
| Status | **Not applicable until §39/§41 findings exist** |

### CLAUDE.SOP37 / release checklist — physical QA and Claude adversarial audit

**Source:** `docs/SOP.md` §37, §47–§49, §61.

Claude appears on the release path: architecture review, adversarial audit, security review, then Cursor fixes. Physical iOS and Android QA are listed.

| Field | Value |
| --- | --- |
| Class | Review + human device QA |
| Status | **Incomplete**. D-001 defers Android **operator app** but not store-device checks if Android is distributed |

### CLAUDE.escalation — Cursor fails twice

**Source:** `docs/SOP.md` ~§54.

Give the problem to Claude as root-cause investigation; Claude proposes one coherent fix.

Status: **process rule**. No evidence required unless a repeated Cursor failure is escalated. **Not applicable** this audit.

## 5. Cursor / other-agent assignments (not Claude)

| Source | Assignment | Status note |
| --- | --- | --- |
| SOP §3, §15, §43 | Cursor implements slices and BLOCKER/HIGH fixes | Historical implementation; not Claude |
| `.cursor/rules/project-authority.mdc` | Cursor obeys PRD/contract | Present |
| SOP §42 prompt says “Give Claude the original PRD” | Named to Claude, executed here by Cursor because the user ordered this audit in Cursor | Substitution, not proof Claude ran |

## 6. Human / manual / external (must not be attributed to Claude)

- Counsel privacy notice (PRV01)
- Staffing on-call / 24h support (OPS04, DEC13)
- Apple / RevenueCat / Resend / Supabase dashboard configuration
- Store screenshots, review identity, TestFlight pilots
- Hosted migration confirmation strings (`APPLY_0026`)
- Approving a release

Claude must not invent staff identities, store products, or hosted apply evidence.

## 7. UI claims about Claude

| Surface | Claim | Supported? |
| --- | --- | --- |
| Mobile i18n | None | N/A |
| Portal | None | N/A |
| Admin | “Staff console screens are not implemented.” | Accurate placeholder; not about Claude |
| Welcome terms | “Terms and Privacy Notice” as non-link text | Misleading vs PRD **links**; unrelated to Claude |

## 8. Missed Claude / SOP responsibilities

1. No dated Claude architecture review (§16) before Stages 1–4.
2. No dated Claude adversarial review (§39).
3. No dated Claude security review (§41).
4. SOP §42 matrix update not performed.
5. SOP §43 fix-verification loop not started.
6. Release checklist items that name Claude are unchecked.
7. This audit must not be cited as “Claude verified production ready.”

## 9. What Claude must still do

1. Read-only architecture review of the current repo vs PRD (SOP §16), or accept this audit’s hierarchy section as input and add Claude-only deltas.
2. Adversarial review focused on remaining HIGH/CRITICAL items (customers, IAP, staff, hosted RLS, deletion revoke).
3. Hostile security review after hosted commercial migrations and any staff auth exist.
4. Re-verify any Cursor fixes of BLOCKER/HIGH items.
5. Refuse fabricated hosted/device evidence.
6. Do not implement during review unless explicitly instructed.
7. Do not commit unless the user asks.

## 10. Verdict on Claude responsibilities

**Not complete.** Instructions exist. Execution evidence in the repository is limited to `CLAUDE.md` plus this Cursor-authored audit. No Anthropic product integration exists, and no misleading “Claude engineers your code” UI exists.
