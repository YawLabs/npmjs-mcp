import { z } from "zod";
import { encPkg, registryGet } from "../api.js";

interface AttestationBundle {
  predicateType: string;
  bundle: unknown;
}

interface AttestationsResponse {
  attestations: AttestationBundle[];
}

export const provenanceTools = [
  {
    name: "npm_provenance",
    description:
      "Get Sigstore provenance attestations for a specific package version. Shows SLSA provenance (which CI built it, from which repo/commit) " +
      "and publish attestations. Essential for supply chain security verification.",
    annotations: {
      title: "Package provenance",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      name: z.string().describe("Package name (e.g. '@anthropic-ai/sdk')"),
      version: z.string().describe("Exact semver version (e.g. '1.0.0')"),
    }),
    handler: async (input: { name: string; version: string }) => {
      const res = await registryGet<AttestationsResponse>(
        `/-/npm/v1/attestations/${encPkg(input.name)}@${input.version}`,
      );
      if (!res.ok) return res;

      const attestations = (res.data!.attestations ?? []).map((a) => ({
        predicateType: a.predicateType,
        bundle: a.bundle,
      }));

      return {
        ok: true,
        status: 200,
        data: {
          package: input.name,
          version: input.version,
          attestationCount: attestations.length,
          hasProvenance: attestations.some((a) => a.predicateType.includes("slsa.dev/provenance")),
          hasPublishAttestation: attestations.some((a) => a.predicateType.includes("npmjs.com/attestation")),
          attestations,
        },
      };
    },
  },
] as const;
