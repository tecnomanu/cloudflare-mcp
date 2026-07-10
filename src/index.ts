import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
// Accepts either a 32-char hex Zone ID or a zone name (e.g. "example.com").
const ZONE = process.env.CLOUDFLARE_ZONE_ID ?? process.env.CLOUDFLARE_ZONE_NAME;

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
    throw new Error((data.errors ?? []).map((e) => e.message).join(", ") || res.statusText);
  }
  return data.result;
}

/**
 * Resolve the configured zone to its hex id. If a 32-char hex is given it is
 * used as-is; otherwise it is treated as a zone name and looked up via the API
 * (requires the token to have Zone:Read on that zone).
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

const ZONE_ID = await resolveZoneId(ZONE);
const BASE_URL = `${API_ROOT}/zones/${ZONE_ID}/dns_records`;

async function cfRequest<T>(path: string, method = "GET", body?: object): Promise<T> {
  return cfFetch<T>(`${BASE_URL}${path}`, method, body);
}

type DnsRecord = {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
};

async function findRecordByName(name: string): Promise<DnsRecord | null> {
  const records = await cfRequest<DnsRecord[]>(
    `?name=${encodeURIComponent(name)}&per_page=5`
  );
  return records[0] ?? null;
}

const server = new McpServer({ name: "cloudflare-mcp", version: "0.1.0" });

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
    const records = await cfRequest<DnsRecord[]>(query);
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
    const record = await cfRequest<DnsRecord>("", "POST", {
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
    const updated = await cfRequest<DnsRecord>(`/${existing.id}`, "PATCH", patch);
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
    await cfRequest(`/${record.id}`, "DELETE");
    return { content: [{ type: "text", text: `✓ Deleted: ${name}` }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
