# cloudflare-mcp

A tiny TypeScript [MCP](https://modelcontextprotocol.io) server to manage the DNS
records of a Cloudflare zone through the Cloudflare API. Zone-agnostic: point it
at any zone via env vars.

## Requirements

- Node.js 18+
- A Cloudflare API token with `Zone:DNS:Edit` (add `Zone:Read` to resolve the
  zone by name instead of by id)

## Configuration

| Variable | Description |
|----------|-------------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with `Zone:DNS:Edit` |
| `CLOUDFLARE_ZONE_ID` | The 32-char hex Zone ID **or** the zone name (e.g. `example.com`). A name is resolved to its id at startup (needs `Zone:Read`). |

Copy `.env.example` to `.env` and fill it in. Never commit `.env`.

## Scripts

```bash
npm install
npm run build   # emit dist/
npm run dev     # tsx src/index.ts (stdio)
npm start       # node dist/index.js
```

## Tools

| Tool | Description |
|------|-------------|
| `dns_list` | List all DNS records in the zone (optional `type` filter: A, CNAME, MX, TXT…) |
| `dns_get` | Get a record by name (e.g. `app.example.com`) |
| `dns_create` | Create a record (type, name, content, proxied, ttl) |
| `dns_update` | Update content/proxy of an existing record by name |
| `dns_delete` | Delete a record by name |

## Example (via an MCP client)

```
dns_list                                → all records
dns_get    name=app.example.com         → inspect one record
dns_create type=CNAME name=dev.example.com content=<tunnel-id>.cfargotunnel.com
dns_update name=dev.example.com proxied=true
dns_delete name=old.example.com
```

## Use as an MCP server

Point your MCP client at the built or dev entrypoint over stdio, passing the two
env vars. Example (generic MCP config):

```json
{
  "command": "npx",
  "args": ["-y", "tsx", "/absolute/path/to/cloudflare-mcp/src/index.ts"],
  "env": {
    "CLOUDFLARE_API_TOKEN": "<your-token>",
    "CLOUDFLARE_ZONE_ID": "example.com"
  }
}
```

## License

MIT
