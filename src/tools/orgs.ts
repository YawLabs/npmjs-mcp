import { z } from "zod";
import { encScope, encTeam, registryGetAuth, requireAuth, validateScope, validateTeam } from "../api.js";
import { translateError } from "../errors.js";

export const orgTools = [
  {
    name: "npm_org_members",
    description:
      "List all members of an npm organization with their roles (owner, admin, developer). Requires authentication as an org member.",
    annotations: {
      title: "List org members",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      org: z.string().describe("Organization name (without @ prefix)"),
    }),
    handler: async (input: { org: string }) => {
      const authErr = requireAuth();
      if (authErr) return authErr;

      const res = await registryGetAuth<Record<string, string>>(`/-/org/${encodeURIComponent(input.org)}/user`);
      if (!res.ok) return translateError(res, { op: `org_members ${input.org}` });

      const members = Object.entries(res.data!).map(([username, role]) => ({ username, role }));
      return {
        ok: true,
        status: 200,
        data: {
          org: input.org,
          memberCount: members.length,
          members,
        },
      };
    },
  },
  {
    name: "npm_org_packages",
    description:
      "List all packages accessible to an npm organization with their access levels. Shows what the org owns or has been granted access to.",
    annotations: {
      title: "List org packages",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      org: z.string().describe("Organization name (without @ prefix)"),
    }),
    handler: async (input: { org: string }) => {
      const authErr = requireAuth();
      if (authErr) return authErr;

      const res = await registryGetAuth<Record<string, string>>(`/-/org/${encodeURIComponent(input.org)}/package`);
      if (!res.ok) return translateError(res, { op: `org_packages ${input.org}` });

      const packages = Object.entries(res.data!).map(([name, access]) => ({ name, access }));
      return {
        ok: true,
        status: 200,
        data: {
          org: input.org,
          packageCount: packages.length,
          packages,
        },
      };
    },
  },
  {
    name: "npm_org_teams",
    description: "List all teams within an npm organization. Requires authentication as an org member.",
    annotations: {
      title: "List org teams",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      org: z.string().describe("Organization name (without @ prefix)"),
    }),
    handler: async (input: { org: string }) => {
      const authErr = requireAuth();
      if (authErr) return authErr;

      const res = await registryGetAuth<string[]>(`/-/org/${encodeURIComponent(input.org)}/team`);
      if (!res.ok) return translateError(res, { op: `org_teams ${input.org}` });

      return {
        ok: true,
        status: 200,
        data: {
          org: input.org,
          teamCount: res.data!.length,
          teams: res.data,
        },
      };
    },
  },
  {
    name: "npm_team_packages",
    description:
      "List all packages a specific team has access to and their permission levels (read-only or read-write). Useful for auditing team permissions.",
    annotations: {
      title: "List team packages",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      org: z.string().describe("Organization name (without @ prefix)"),
      team: z.string().describe("Team name"),
    }),
    handler: async (input: { org: string; team: string }) => {
      const authErr = requireAuth();
      if (authErr) return authErr;

      const res = await registryGetAuth<Record<string, string>>(
        `/-/team/${encodeURIComponent(input.org)}/${encodeURIComponent(input.team)}/package`,
      );
      if (!res.ok) return translateError(res, { op: `team_packages ${input.org}:${input.team}` });

      const packages = Object.entries(res.data!).map(([name, permissions]) => ({ name, permissions }));
      return {
        ok: true,
        status: 200,
        data: {
          org: input.org,
          team: input.team,
          packageCount: packages.length,
          packages,
        },
      };
    },
  },
  {
    name: "npm_team_members",
    description:
      "List all members of a team with their roles (e.g. 'developer'). Complements npm_team_member_add and npm_team_member_remove — use this to audit who is currently on the team before adding or removing members.",
    annotations: {
      title: "List team members",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      org: z.string().describe("Organization name (without @ prefix)"),
      team: z.string().describe("Team name"),
    }),
    handler: async (input: { org: string; team: string }) => {
      const authErr = requireAuth();
      if (authErr) return authErr;

      const scopeErr = validateScope(input.org);
      if (scopeErr) return { ok: false, status: 400, error: scopeErr };
      const teamErr = validateTeam(input.team);
      if (teamErr) return { ok: false, status: 400, error: teamErr };

      const res = await registryGetAuth<Record<string, string>>(
        `/-/team/${encScope(input.org)}/${encTeam(input.team)}/user`,
      );
      if (!res.ok) return translateError(res, { op: `team_members ${input.org}:${input.team}` });

      const members = Object.entries(res.data!).map(([username, role]) => ({ username, role }));
      return {
        ok: true,
        status: 200,
        data: {
          org: input.org,
          team: input.team,
          memberCount: members.length,
          members,
        },
      };
    },
  },
] as const;
