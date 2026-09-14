import { describe, expect, it } from "vitest";
import { findForbiddenSecrets } from "./index.ts";

describe("findForbiddenSecrets", () => {
  it("flags the forbidden database role name", () => {
    expect(findForbiddenSecrets(`DATABASE_URL=${["service", "role"].join("_")}`)).not.toHaveLength(0);
  });

  it("allows documented application source without that role", () => {
    expect(findForbiddenSecrets("const x = 1;")).toHaveLength(0);
  });
});
