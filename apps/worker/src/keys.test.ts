import { originalPdfObjectKey } from "@job-to-invoice/domain";
import { describe, expect, it } from "vitest";

describe("original PDF object keys", () => {
  it("namespaces tenant, document, revision, and artifact", () => {
    expect(
      originalPdfObjectKey({
        workspaceId: "11111111-1111-4111-8111-111111111111",
        documentId: "22222222-2222-4222-8222-222222222222",
        revision: 1,
        artifactId: "33333333-3333-4333-8333-333333333333",
      }),
    ).toBe(
      "workspaces/11111111-1111-4111-8111-111111111111/documents/22222222-2222-4222-8222-222222222222/revisions/1/original/33333333-3333-4333-8333-333333333333.pdf",
    );
  });
});
