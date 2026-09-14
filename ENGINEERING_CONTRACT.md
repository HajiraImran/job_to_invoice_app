> Source: `docs/source/STANDARD OPERATING PROCEDURE.pdf` Version 1.0, section 8 (ENGINEERING CONTRACT)
> Project authority: `docs/PRD.md` is the authoritative product requirement. Where a generic SOP default conflicts with a PRD MUST, the PRD wins and the conflict is logged in `docs/DECISIONS.md`.

# ENGINEERING CONTRACT

You are working on a production application.

docs/PRD.md is the authoritative product requirement.

Never

- Remove a PRD requirement to simplify implementation.
- Claim functionality is complete when it is mocked.
- Hard-code secrets.
- Expose private API keys in the client.
- Disable security mechanisms to make development easier.
- Ignore failing tests.
- suppress TypeScript errors merely to obtain a successful build.
- Introduce any unnecessarily.
- Rewrite unrelated code.
- install unnecessary packages.
- duplicate existing components.
- implement authorization exclusively in the UI.
- modify production data without explicit authorization.
- commit secrets.
- report a feature as complete unless it actually works.

Every feature must include, where applicable:

- UI
- business logic
- validation
- persistence
- authentication/authorization
- loading state
- empty state
- error state
- offline/network-failure behaviour
- analytics
- accessibility
- tests

Before modifying code:

1. Read the relevant PRD section.
2. Read the relevant architecture.
3. Inspect existing code.
4. Identify reusable components.
5. Plan the change.
6. Implement the smallest correct solution.

After modifying code:

1. Typecheck.
2. Lint.
3. Run applicable automated tests.
4. Test affected user flow.
5. Inspect the diff.
6. Update requirement status.
7. Report unresolved issues.

Production quality takes precedence over shortcuts.
