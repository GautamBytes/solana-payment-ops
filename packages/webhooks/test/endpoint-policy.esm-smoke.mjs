import assert from "node:assert/strict";
import { validateEndpointUrl } from "../dist/index.js";

assert.equal(
  validateEndpointUrl("https://hooks.example.com/payops").url,
  "https://hooks.example.com/payops",
);
assert.throws(
  () => validateEndpointUrl("https://127.0.0.1/hook"),
  (error) => error instanceof Error && error.code === "unsafe_endpoint",
);
