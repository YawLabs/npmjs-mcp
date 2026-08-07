import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { accessTools } from "./access.js";
import { analysisTools } from "./analysis.js";
import { authTools } from "./auth.js";
import { dependencyTools } from "./dependencies.js";
import { downloadTools } from "./downloads.js";
import { hookTools } from "./hooks.js";
import { orgTools } from "./orgs.js";
import { packageTools } from "./packages.js";
import { provenanceTools } from "./provenance.js";
import { registryTools } from "./registry.js";
import { searchTools } from "./search.js";
import { securityTools } from "./security.js";
import { trustTools } from "./trust.js";
import { workflowTools } from "./workflows.js";
import { writeTools } from "./writes.js";

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
  ...writeTools,
  ...hookTools,
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
    // Derived from the sum of per-module counts below so it stays in sync
    // automatically when a module gains or loses tools.
    const expectedTotal =
      1 +  // searchTools
      6 +  // packageTools
      3 +  // dependencyTools
      4 +  // downloadTools
      3 +  // securityTools
      4 +  // analysisTools
      3 +  // registryTools
      5 +  // authTools
      5 +  // orgTools
      2 +  // accessTools
      1 +  // provenanceTools
      1 +  // trustTools
      2 +  // workflowTools
      19 + // writeTools
      5;   // hookTools
    assert.equal(allTools.length, expectedTotal);
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

      it("a read-only tool is never marked destructive", () => {
        // The MCP spec scopes destructiveHint to tools that are NOT read-only,
        // where it means "may perform destructive updates". So the real
        // invariant is one-directional: readOnly implies non-destructive.
        //
        // The previous assertion required the two to be strict opposites, which
        // forced every write tool to claim destructiveHint: true -- including
        // purely additive ones (npm_owner_add, npm_team_create,
        // npm_team_member_add, npm_hook_add) that remove nothing. Hosts that
        // gate confirmation on the hint then over-prompt on safe operations,
        // which trains users to click through the prompts that matter.
        if (tool.annotations.readOnlyHint) {
          assert.equal(
            tool.annotations.destructiveHint,
            false,
            `Tool ${tool.name} is readOnlyHint: true, so destructiveHint must be false`,
          );
        }
      });
    });
  }
});

describe("Destructive annotations", () => {
  // Pins the classification so a new write tool has to make a deliberate call,
  // and so a future refactor can't quietly re-flag the additive ops as
  // destructive (or, worse, de-flag a genuinely destructive one).
  const ADDITIVE_WRITES = [
    "npm_owner_add",
    "npm_team_create",
    "npm_team_member_add",
    "npm_hook_add",
  ];

  for (const name of ADDITIVE_WRITES) {
    it(`${name} is a write but not destructive`, () => {
      const tool = allTools.find((t) => t.name === name);
      assert.ok(tool, `${name} not found`);
      assert.equal(tool!.annotations.readOnlyHint, false, `${name} should be a write`);
      assert.equal(tool!.annotations.destructiveHint, false, `${name} only adds; it must not claim destructiveness`);
    });
  }

  it("every irreversible op is still marked destructive", () => {
    const IRREVERSIBLE = [
      "npm_unpublish_version",
      "npm_unpublish_package",
      "npm_deprecate",
      "npm_owner_remove",
      "npm_team_delete",
      "npm_team_member_remove",
      "npm_org_member_remove",
      "npm_token_revoke",
      "npm_hook_remove",
      "npm_dist_tag_remove",
    ];
    for (const name of IRREVERSIBLE) {
      const tool = allTools.find((t) => t.name === name);
      assert.ok(tool, `${name} not found`);
      assert.equal(tool!.annotations.destructiveHint, true, `${name} must stay destructiveHint: true`);
    }
  });
});

describe("Tool modules export correct counts", () => {
  it("searchTools has 1 tool", () => assert.equal(searchTools.length, 1));
  it("packageTools has 6 tools", () => assert.equal(packageTools.length, 6));
  it("dependencyTools has 3 tools", () => assert.equal(dependencyTools.length, 3));
  it("downloadTools has 4 tools", () => assert.equal(downloadTools.length, 4));
  it("securityTools has 3 tools", () => assert.equal(securityTools.length, 3));
  it("analysisTools has 4 tools", () => assert.equal(analysisTools.length, 4));
  it("registryTools has 3 tools", () => assert.equal(registryTools.length, 3));
  it("authTools has 5 tools", () => assert.equal(authTools.length, 5));
  it("orgTools has 5 tools", () => assert.equal(orgTools.length, 5));
  it("accessTools has 2 tools", () => assert.equal(accessTools.length, 2));
  it("provenanceTools has 1 tool", () => assert.equal(provenanceTools.length, 1));
  it("trustTools has 1 tool", () => assert.equal(trustTools.length, 1));
  it("workflowTools has 2 tools", () => assert.equal(workflowTools.length, 2));
  it("writeTools has 19 tools", () => assert.equal(writeTools.length, 19));
  it("hookTools has 5 tools", () => assert.equal(hookTools.length, 5));
});
