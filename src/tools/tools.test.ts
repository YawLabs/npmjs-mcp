import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { accessTools } from "./access.js";
import { analysisTools } from "./analysis.js";
import { authTools } from "./auth.js";
import { dependencyTools } from "./dependencies.js";
import { downloadTools } from "./downloads.js";
import { orgTools } from "./orgs.js";
import { packageTools } from "./packages.js";
import { provenanceTools } from "./provenance.js";
import { registryTools } from "./registry.js";
import { searchTools } from "./search.js";
import { securityTools } from "./security.js";
import { trustTools } from "./trust.js";
import { workflowTools } from "./workflows.js";

const allTools = [
  ...searchTools,
  ...packageTools,
  ...dependencyTools,
  ...downloadTools,
  ...securityTools,
  ...analysisTools,
  ...registryTools,
  ...authTools,
  ...orgTools,
  ...accessTools,
  ...provenanceTools,
  ...trustTools,
  ...workflowTools,
];

describe("Tool definitions", () => {
  it("should have no duplicate tool names", () => {
    const names = allTools.map((t) => t.name);
    const unique = new Set(names);
    assert.equal(
      names.length,
      unique.size,
      `Duplicate tool names found: ${names.filter((n, i) => names.indexOf(n) !== i)}`,
    );
  });

  it("should have the expected total tool count", () => {
    assert.equal(allTools.length, 37);
  });

  for (const tool of allTools) {
    describe(tool.name, () => {
      it("should have a non-empty name", () => {
        assert.ok(tool.name.length > 0);
      });

      it("should have a name prefixed with npm_", () => {
        assert.ok(tool.name.startsWith("npm_"), `Tool name ${tool.name} should start with npm_`);
      });

      it("should have a non-empty description", () => {
        assert.ok(tool.description.length > 0);
      });

      it("should have a Zod input schema", () => {
        assert.ok(tool.inputSchema);
        assert.ok(typeof tool.inputSchema.shape === "object");
      });

      it("should have an async handler function", () => {
        assert.equal(typeof tool.handler, "function");
      });

      it("should have annotations with required hints", () => {
        assert.ok(tool.annotations, `Tool ${tool.name} is missing annotations`);
        assert.equal(typeof tool.annotations.readOnlyHint, "boolean", `Tool ${tool.name} missing readOnlyHint`);
        assert.equal(typeof tool.annotations.destructiveHint, "boolean", `Tool ${tool.name} missing destructiveHint`);
        assert.equal(typeof tool.annotations.idempotentHint, "boolean", `Tool ${tool.name} missing idempotentHint`);
        assert.equal(typeof tool.annotations.openWorldHint, "boolean", `Tool ${tool.name} missing openWorldHint`);
      });

      it("should be read-only", () => {
        assert.equal(tool.annotations.readOnlyHint, true, `Tool ${tool.name} should be readOnly`);
        assert.equal(tool.annotations.destructiveHint, false, `Tool ${tool.name} should not be destructive`);
      });
    });
  }
});

describe("Tool modules export correct counts", () => {
  it("searchTools has 1 tool", () => assert.equal(searchTools.length, 1));
  it("packageTools has 6 tools", () => assert.equal(packageTools.length, 6));
  it("dependencyTools has 3 tools", () => assert.equal(dependencyTools.length, 3));
  it("downloadTools has 4 tools", () => assert.equal(downloadTools.length, 4));
  it("securityTools has 3 tools", () => assert.equal(securityTools.length, 3));
  it("analysisTools has 4 tools", () => assert.equal(analysisTools.length, 4));
  it("registryTools has 2 tools", () => assert.equal(registryTools.length, 2));
  it("authTools has 4 tools", () => assert.equal(authTools.length, 4));
  it("orgTools has 4 tools", () => assert.equal(orgTools.length, 4));
  it("accessTools has 2 tools", () => assert.equal(accessTools.length, 2));
  it("provenanceTools has 1 tool", () => assert.equal(provenanceTools.length, 1));
  it("trustTools has 1 tool", () => assert.equal(trustTools.length, 1));
  it("workflowTools has 2 tools", () => assert.equal(workflowTools.length, 2));
});
