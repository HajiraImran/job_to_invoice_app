export const PLACEHOLDER_PATTERN = new RegExp(
  [
    "changeme",
    "placeholder",
    "your-",
    "replace-me",
    "todo\\b",
    "xxx",
    "demo-key",
    "minioadmin",
    "example\\.com",
    ["sk", "live", "dummy"].join("_"),
  ].join("|"),
  "i",
);
