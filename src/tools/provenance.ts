import { z } from "zod";
import { encPkg, registryGet } from "../api.js";
import { translateError } from "../errors.js";

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
      "Retrieve Sigstore attestations for a specific package version. Shows SLSA provenance (which CI built it, from which repo/commit) " +
      "and publish attestations. NOTE: this tool RETRIEVES attestations from the registry -- it does NOT perform cryptographic signature, " +
      "certificate-chain, or Rekor transparency-log verification. Use a dedicated Sigstore client to cryptographically verify the bundles.",
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
      if (!input.version || !input.version.trim()) {
        return { ok: false as const, status: 400, error: "version is required and must not be empty" };
      }
      // Both name and version must be URL-encoded. Versions with build metadata (e.g.
      // '1.0.0-beta+exp.sha.5114f85') contain '+' which URL-decoders treat as space —
      // leaving it unencoded produces a silent 404 from the registry.
      const res = await registryGet<AttestationsResponse>(
        `/-/npm/v1/attestations/${encPkg(input.name)}@${encodeURIComponent(input.version)}`,
      );
      if (!res.ok) return translateError(res, { pkg: input.name, op: `provenance ${input.version}` });

      const attestations = (res.data?.attestations ?? []).map((a) => ({
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
          hasProvenance: attestations.some((a) => a.predicateType.startsWith("https://slsa.dev/provenance")),
          hasPublishAttestation: attestations.some((a) =>
            a.predicateType.startsWith("https://npmjs.com/attestation"),
          ),
          attestations,
        },
      };
    },
  },
] as const;
