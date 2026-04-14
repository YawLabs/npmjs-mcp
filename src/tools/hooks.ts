/**
 * Registry webhook tools — add/list/get/update/delete hooks via /-/npm/v1/hooks.
 *
 * Hook targets are detected by name shape:
 *   - "@scope/pkg" or "pkg"  → type: package
 *   - "@scope"               → type: scope
 *   - "~user"                → type: owner (name stripped of leading ~)
 */

import { z } from "zod";
import { registryDeleteAuth, registryGetAuth, registryPostAuth, registryPutAuth, requireAuth } from "../api.js";
import { translateError } from "../errors.js";

function classifyHookTarget(target: string): { type: "package" | "scope" | "owner"; name: string } {
  if (target.startsWith("~")) return { type: "owner", name: target.slice(1) };
  if (/^@[^/]+$/.test(target)) return { type: "scope", name: target };
  return { type: "package", name: target };
}

export const hookTools = [
  {
    name: "npm_hook_add",
    description:
      "Create a registry webhook. Target is 'pkg' or '@scope/pkg' for a package, '@scope' for a scope, " +
      "or '~user' for a user's packages. Endpoint is the HTTPS URL to POST events to; " +
      "secret is used to HMAC-sign payloads.",
    annotations: {
      title: "Add webhook",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      target: z.string().describe("Hook target: 'pkg', '@scope/pkg', '@scope', or '~user'"),
      endpoint: z.string().url().describe("HTTPS URL that will receive POST events"),
      secret: z.string().describe("Secret used to HMAC-sign webhook payloads"),
    }),
    handler: async (input: { target: string; endpoint: string; secret: string }) => {
      const authErr = requireAuth();
      if (authErr) return authErr;

      const { type, name } = classifyHookTarget(input.target);
      const res = await registryPostAuth("/-/npm/v1/hooks/hook", {
        type,
        name,
        endpoint: input.endpoint,
        secret: input.secret,
      });
      if (!res.ok) return translateError(res, { op: `hook_add ${input.target}` });

      return { ok: true, status: 200, data: res.data };
    },
  },

  {
    name: "npm_hook_list",
    description: "List webhooks. Optionally filter by package name.",
    annotations: {
      title: "List webhooks",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      package: z.string().optional().describe("Filter by package name"),
      limit: z.number().int().optional().describe("Max results"),
      offset: z.number().int().optional().describe("Pagination offset"),
    }),
    handler: async (input: { package?: string; limit?: number; offset?: number }) => {
      const authErr = requireAuth();
      if (authErr) return authErr;

      const qs = new URLSearchParams();
      if (input.package) qs.set("package", input.package);
      if (input.limit !== undefined) qs.set("limit", String(input.limit));
      if (input.offset !== undefined) qs.set("offset", String(input.offset));
      const q = qs.toString();

      const res = await registryGetAuth(`/-/npm/v1/hooks${q ? `?${q}` : ""}`);
      if (!res.ok) return translateError(res, { op: "hook_list" });

      return { ok: true, status: 200, data: res.data };
    },
  },

  {
    name: "npm_hook_get",
    description: "Get a single webhook by its ID.",
    annotations: {
      title: "Get webhook",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      id: z.string().describe("Hook ID (UUID from npm_hook_list)"),
    }),
    handler: async (input: { id: string }) => {
      const authErr = requireAuth();
      if (authErr) return authErr;

      const res = await registryGetAuth(`/-/npm/v1/hooks/hook/${encodeURIComponent(input.id)}`);
      if (!res.ok) return translateError(res, { op: `hook_get ${input.id}` });

      return { ok: true, status: 200, data: res.data };
    },
  },

  {
    name: "npm_hook_update",
    description: "Update a webhook's endpoint and/or secret.",
    annotations: {
      title: "Update webhook",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      id: z.string().describe("Hook ID"),
      endpoint: z.string().url().describe("New HTTPS URL"),
      secret: z.string().describe("New signing secret"),
    }),
    handler: async (input: { id: string; endpoint: string; secret: string }) => {
      const authErr = requireAuth();
      if (authErr) return authErr;

      const res = await registryPutAuth(`/-/npm/v1/hooks/hook/${encodeURIComponent(input.id)}`, {
        endpoint: input.endpoint,
        secret: input.secret,
      });
      if (!res.ok) return translateError(res, { op: `hook_update ${input.id}` });

      return { ok: true, status: 200, data: res.data };
    },
  },

  {
    name: "npm_hook_remove",
    description: "Delete a webhook by ID.",
    annotations: {
      title: "Remove webhook",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      id: z.string().describe("Hook ID"),
    }),
    handler: async (input: { id: string }) => {
      const authErr = requireAuth();
      if (authErr) return authErr;

      const res = await registryDeleteAuth(`/-/npm/v1/hooks/hook/${encodeURIComponent(input.id)}`);
      if (!res.ok) return translateError(res, { op: `hook_remove ${input.id}` });

      return { ok: true, status: 200, data: { id: input.id, removed: true } };
    },
  },
] as const;
