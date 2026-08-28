import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
// Accepts either a 32-char hex Zone ID or a zone name (e.g. "example.com").
const ZONE = process.env.CLOUDFLARE_ZONE_ID ?? process.env.CLOUDFLARE_ZONE_NAME;
// Optional: account id for tunnel endpoints. Resolved from the API if omitted.
const ACCOUNT_ENV = process.env.CLOUDFLARE_ACCOUNT_ID;

if (!API_TOKEN || !ZONE) {
  console.error(
    "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID (hex id or zone name) are required"
  );
  process.exit(1);
}

const API_ROOT = "https://api.cloudflare.com/client/v4";

const headers = {
  Authorization: `Bearer ${API_TOKEN}`,
  "Content-Type": "application/json",
};

type CfEnvelope<T> = {
  success: boolean;
  result: T;
  errors: { message: string }[];
};

async function cfFetch<T>(url: string, method = "GET", body?: object): Promise<T> {
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json()) as CfEnvelope<T>;
  if (!data.success) {
    throw new Error(
      (data.errors ?? []).map((e) => e.message).join(", ") || res.statusText
    );
  }
  return data.result;
}

/**
 * Resolve the configured zone to its hex id. A 32-char hex is used as-is;
 * otherwise it is treated as a zone name and looked up (needs Zone:Read).
 */
async function resolveZoneId(zone: string): Promise<string> {
  if (/^[0-9a-f]{32}$/i.test(zone)) return zone;
  const zones = await cfFetch<{ id: string; name: string }[]>(
    `${API_ROOT}/zones?name=${encodeURIComponent(zone)}`
  );
  const match = zones[0];
  if (!match) {
    throw new Error(
      `Zone '${zone}' not found for this API token. Set CLOUDFLARE_ZONE_ID to the hex Zone ID, or grant the token Zone:Read.`
    );
  }
  return match.id;
}

/**
 * Resolve the account id from env, else from the zone (needs only Zone:Read),
 * else from the token's accounts list (needs Account:Read).
 */
async function resolveAccountId(zoneId: string): Promise<string | null> {
  if (ACCOUNT_ENV) return ACCOUNT_ENV;
  try {
    const zone = await cfFetch<{ account?: { id: string } }>(
      `${API_ROOT}/zones/${zoneId}`
    );
    if (zone.account?.id) return zone.account.id;
  } catch {
    /* fall through */
  }
  try {
    const accounts = await cfFetch<{ id: string; name: string }[]>(
      `${API_ROOT}/accounts?per_page=50`
    );
    return accounts[0]?.id ?? null;
  } catch {
    return null;
  }
}

const ZONE_ID = await resolveZoneId(ZONE);
const ACCOUNT_ID = await resolveAccountId(ZONE_ID);
const BASE_URL = `${API_ROOT}/zones/${ZONE_ID}/dns_records`;

async function dnsRequest<T>(path: string, method = "GET", body?: object): Promise<T> {
  return cfFetch<T>(`${BASE_URL}${path}`, method, body);
}

function tunnelBase(): string {
  if (!ACCOUNT_ID) {
    throw new Error(
      "No account id available. Set CLOUDFLARE_ACCOUNT_ID, or grant the token Account:Read so it can be resolved."
    );
  }
  return `${API_ROOT}/accounts/${ACCOUNT_ID}/cfd_tunnel`;
}

type DnsRecord = {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
};

type Tunnel = {
  id: string;
  name: string;
  status?: string;
  deleted_at?: string | null;
  connections?: unknown[];
};

async function findRecordByName(name: string): Promise<DnsRecord | null> {
  const records = await dnsRequest<DnsRecord[]>(
    `?name=${encodeURIComponent(name)}&per_page=5`
  );
  return records[0] ?? null;
}

async function findTunnelByName(name: string): Promise<Tunnel | null> {
  const tunnels = await cfFetch<Tunnel[]>(
    `${tunnelBase()}?name=${encodeURIComponent(name)}&is_deleted=false`
  );
  return tunnels[0] ?? null;
}

const server = new McpServer({ name: "cloudflare-mcp", version: "0.2.0" });

// ─────────────────────────────── DNS ────────────────────────────────

server.registerTool(
  "dns_list",
  {
    description: "List all DNS records in the configured Cloudflare zone",
    inputSchema: {
      type: z
        .string()
        .optional()
        .describe("Filter by record type (A, CNAME, MX, TXT...)"),
    },
  },
  async ({ type }) => {
    const query = type ? `?type=${type}&per_page=100` : "?per_page=100";
    const records = await dnsRequest<DnsRecord[]>(query);
    const lines = records.map(
      (r) =>
        `${r.type.padEnd(6)} ${r.name.padEnd(40)} → ${r.content}  proxied=${r.proxied}`
    );
    return {
      content: [{ type: "text", text: lines.join("\n") || "No records found." }],
    };
  }
);

server.registerTool(
  "dns_get",
  {
    description: "Get a DNS record by name",
    inputSchema: {
      name: z.string().describe("Full record name, e.g. app.example.com"),
    },
  },
  async ({ name }) => {
    const record = await findRecordByName(name);
    if (!record)
      return { content: [{ type: "text", text: `Record '${name}' not found.` }] };
    return {
      content: [
        {
          type: "text",
          text: `id: ${record.id}\ntype: ${record.type}\nname: ${record.name}\ncontent: ${record.content}\nproxied: ${record.proxied}\nttl: ${record.ttl}`,
        },
      ],
    };
  }
);

server.registerTool(
  "dns_create",
  {
    description: "Create a new DNS record",
    inputSchema: {
      type: z
        .enum(["A", "AAAA", "CNAME", "MX", "TXT", "NS"])
        .describe("Record type"),
      name: z.string().describe("Record name, e.g. new.example.com"),
      content: z
        .string()
        .describe("Record value (IP for A, hostname for CNAME, etc.)"),
      proxied: z
        .boolean()
        .optional()
        .default(true)
        .describe("Proxy through Cloudflare CDN (default: true)"),
      ttl: z.number().optional().default(1).describe("TTL in seconds (1 = auto)"),
    },
  },
  async ({ type, name, content, proxied, ttl }) => {
    const record = await dnsRequest<DnsRecord>("", "POST", {
      type,
      name,
      content,
      proxied,
      ttl,
    });
    return {
      content: [
        {
          type: "text",
          text: `✓ Created: ${record.name} → ${record.content}  proxied=${record.proxied}  id=${record.id}`,
        },
      ],
    };
  }
);

server.registerTool(
  "dns_update",
  {
    description: "Update an existing DNS record",
    inputSchema: {
      name: z.string().describe("Record name to update"),
      content: z.string().optional().describe("New content/IP value"),
      proxied: z.boolean().optional().describe("Toggle Cloudflare proxy"),
    },
  },
  async ({ name, content, proxied }) => {
    const existing = await findRecordByName(name);
    if (!existing)
      return { content: [{ type: "text", text: `Record '${name}' not found.` }] };
    const patch: Partial<DnsRecord> = {};
    if (content !== undefined) patch.content = content;
    if (proxied !== undefined) patch.proxied = proxied;
    const updated = await dnsRequest<DnsRecord>(`/${existing.id}`, "PATCH", patch);
    return {
      content: [
        {
          type: "text",
          text: `✓ Updated: ${updated.name} → ${updated.content}  proxied=${updated.proxied}`,
        },
      ],
    };
  }
);

server.registerTool(
  "dns_delete",
  {
    description: "Delete a DNS record by name",
    inputSchema: {
      name: z.string().describe("Record name to delete, e.g. old.example.com"),
    },
  },
  async ({ name }) => {
    const record = await findRecordByName(name);
    if (!record)
      return { content: [{ type: "text", text: `Record '${name}' not found.` }] };
    await dnsRequest(`/${record.id}`, "DELETE");
    return { content: [{ type: "text", text: `✓ Deleted: ${name}` }] };
  }
);

// ─────────────────────────── Tunnels (cfd) ──────────────────────────
// Requires the token to have Account:Cloudflare Tunnel:Edit (and Account:Read
// to auto-resolve the account id).

server.registerTool(
  "tunnel_list",
  {
    description: "List Cloudflare (cloudflared) tunnels in the account",
    inputSchema: {},
  },
  async () => {
    const tunnels = await cfFetch<Tunnel[]>(`${tunnelBase()}?is_deleted=false`);
    const lines = tunnels.map(
      (t) => `${t.id}  ${t.name.padEnd(24)} conns=${t.connections?.length ?? 0}`
    );
    return {
      content: [{ type: "text", text: lines.join("\n") || "No tunnels." }],
    };
  }
);

server.registerTool(
  "tunnel_create",
  {
    description:
      "Create a remotely-managed cloudflared tunnel and return its run token. Idempotent by name.",
    inputSchema: {
      name: z.string().describe("Tunnel name, e.g. my-dev"),
    },
  },
  async ({ name }) => {
    let tunnel = await findTunnelByName(name);
    if (!tunnel) {
      tunnel = await cfFetch<Tunnel>(tunnelBase(), "POST", {
        name,
        config_src: "cloudflare",
      });
    }
    const token = await cfFetch<string>(`${tunnelBase()}/${tunnel.id}/token`);
    return {
      content: [
        {
          type: "text",
          text: `id: ${tunnel.id}\nname: ${tunnel.name}\ncname: ${tunnel.id}.cfargotunnel.com\ntoken: ${token}`,
        },
      ],
    };
  }
);

server.registerTool(
  "tunnel_token",
  {
    description: "Get the run token for an existing tunnel (by name)",
    inputSchema: {
      name: z.string().describe("Tunnel name"),
    },
  },
  async ({ name }) => {
    const tunnel = await findTunnelByName(name);
    if (!tunnel)
      return { content: [{ type: "text", text: `Tunnel '${name}' not found.` }] };
    const token = await cfFetch<string>(`${tunnelBase()}/${tunnel.id}/token`);
    return {
      content: [{ type: "text", text: `id: ${tunnel.id}\ntoken: ${token}` }],
    };
  }
);

server.registerTool(
  "tunnel_configure",
  {
    description:
      "Set the public-hostname ingress of a tunnel (hostname → local service). Adds a catch-all 404.",
    inputSchema: {
      name: z.string().describe("Tunnel name"),
      hostname: z.string().describe("Public hostname, e.g. dev.example.com"),
      service: z
        .string()
        .describe("Local origin, e.g. http://localhost:8770"),
    },
  },
  async ({ name, hostname, service }) => {
    const tunnel = await findTunnelByName(name);
    if (!tunnel)
      return { content: [{ type: "text", text: `Tunnel '${name}' not found.` }] };
    await cfFetch(`${tunnelBase()}/${tunnel.id}/configurations`, "PUT", {
      config: {
        ingress: [
          { hostname, service },
          { service: "http_status:404" },
        ],
      },
    });
    return {
      content: [
        { type: "text", text: `✓ ${hostname} → ${service} (tunnel ${tunnel.name})` },
      ],
    };
  }
);

server.registerTool(
  "tunnel_delete",
  {
    description: "Delete a tunnel by name (fails if it has active connections)",
    inputSchema: {
      name: z.string().describe("Tunnel name"),
    },
  },
  async ({ name }) => {
    const tunnel = await findTunnelByName(name);
    if (!tunnel)
      return { content: [{ type: "text", text: `Tunnel '${name}' not found.` }] };
    await cfFetch(`${tunnelBase()}/${tunnel.id}`, "DELETE");
    return { content: [{ type: "text", text: `✓ Deleted tunnel: ${name}` }] };
  }
);

// ─────────────────────────── Email Routing ──────────────────────────

type EmailRule = {
  id: string;
  tag: string;
  name: string;
  enabled: boolean;
  matchers: { type: string; field?: string; value?: string }[];
  actions: { type: string; value?: string[] }[];
};

type EmailDestination = {
  email: string;
  verified: string | null;
  created: string;
};

function emailZoneBase(): string {
  return `${API_ROOT}/zones/${ZONE_ID}/email/routing`;
}

function emailAccountBase(): string {
  if (!ACCOUNT_ID) {
    throw new Error(
      "No account id available. Set CLOUDFLARE_ACCOUNT_ID, or grant the token Account:Read so it can be resolved."
    );
  }
  return `${API_ROOT}/accounts/${ACCOUNT_ID}/email/routing`;
}

function describeRule(r: EmailRule): string {
  const from = r.matchers
    .map((m) => (m.type === "all" ? "(catch-all)" : m.value ?? m.type))
    .join(", ");
  const to = r.actions
    .map((a) => `${a.type}:${(a.value ?? []).join("|") || "-"}`)
    .join(", ");
  return `${r.enabled ? "on " : "off"} ${from.padEnd(34)} → ${to}`;
}

server.registerTool(
  "email_routing_status",
  {
    description:
      "Show whether Cloudflare Email Routing is enabled on the zone (needs Email Routing Rules:Read)",
    inputSchema: {},
  },
  async () => {
    const status = await cfFetch<{
      enabled: boolean;
      name: string;
      status: string;
      skip_wizard?: boolean;
    }>(emailZoneBase());
    return {
      content: [
        {
          type: "text",
          text: `zone: ${status.name}\nenabled: ${status.enabled}\nstatus: ${status.status}`,
        },
      ],
    };
  }
);

server.registerTool(
  "email_rules_list",
  {
    description:
      "List Email Routing rules (which @zone addresses forward where), including the catch-all",
    inputSchema: {},
  },
  async () => {
    const rules = await cfFetch<EmailRule[]>(`${emailZoneBase()}/rules?per_page=50`);
    const lines = rules.map(describeRule);
    try {
      const catchAll = await cfFetch<EmailRule>(`${emailZoneBase()}/rules/catch_all`);
      lines.push(describeRule(catchAll));
    } catch {
      /* catch-all unreadable or unset */
    }
    return {
      content: [{ type: "text", text: lines.join("\n") || "No routing rules." }],
    };
  }
);

server.registerTool(
  "email_destinations_list",
  {
    description:
      "List the account's destination addresses for Email Routing and whether each is verified (needs Email Routing Addresses:Read)",
    inputSchema: {},
  },
  async () => {
    const addresses = await cfFetch<EmailDestination[]>(
      `${emailAccountBase()}/addresses?per_page=50`
    );
    const lines = addresses.map(
      (a) => `${a.verified ? "verified  " : "UNVERIFIED"} ${a.email}`
    );
    return {
      content: [
        { type: "text", text: lines.join("\n") || "No destination addresses." },
      ],
    };
  }
);

server.registerTool(
  "email_rule_create",
  {
    description:
      "Forward an address on this zone to a destination address. The destination must already be verified in Cloudflare.",
    inputSchema: {
      address: z
        .string()
        .describe("Local part or full address, e.g. 'hola' or 'hola@example.com'"),
      destination: z
        .string()
        .describe("Verified destination address to forward to"),
    },
  },
  async ({ address, destination }) => {
    const zoneName = await cfFetch<{ name: string }>(`${API_ROOT}/zones/${ZONE_ID}`);
    const from = address.includes("@") ? address : `${address}@${zoneName.name}`;
    const rule = await cfFetch<EmailRule>(`${emailZoneBase()}/rules`, "POST", {
      name: `forward ${from}`,
      enabled: true,
      matchers: [{ type: "literal", field: "to", value: from }],
      actions: [{ type: "forward", value: [destination] }],
    });
    return {
      content: [{ type: "text", text: `✓ ${from} → ${destination} (${rule.tag})` }],
    };
  }
);

server.registerTool(
  "email_destination_add",
  {
    description:
      "Add a destination address for Email Routing. Cloudflare emails it a verification link that the owner must click before it can receive forwards.",
    inputSchema: {
      email: z.string().describe("Destination address, e.g. you@gmail.com"),
    },
  },
  async ({ email }) => {
    const created = await cfFetch<EmailDestination>(
      `${emailAccountBase()}/addresses`,
      "POST",
      { email }
    );
    return {
      content: [
        {
          type: "text",
          text: `✓ ${created.email} added — ${created.verified ? "already verified" : "verification email sent, click the link to confirm"}`,
        },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
