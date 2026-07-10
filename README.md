# cloudflare-mcp

A tiny TypeScript [MCP](https://modelcontextprotocol.io) server to manage the DNS
records of a Cloudflare zone through the Cloudflare API. Zone-agnostic: point it
at any zone via env vars.

## Requirements

- Node.js 18+
- A Cloudflare API token. Permissions by feature:
  - DNS tools → `Zone:DNS:Edit` (+ `Zone:Read` to resolve the zone by name)
  - Tunnel tools → `Account:Cloudflare Tunnel:Edit` (+ `Account:Account
    Settings:Read` to auto-resolve the account id)

## Configuration

| Variable | Description |
|----------|-------------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token (see permissions above) |
| `CLOUDFLARE_ZONE_ID` | The 32-char hex Zone ID **or** the zone name (e.g. `example.com`). A name is resolved to its id at startup (needs `Zone:Read`). |
| `CLOUDFLARE_ACCOUNT_ID` | Optional. Account id for tunnel tools. Auto-resolved from the token if omitted (needs `Account:Read`). |

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
| `tunnel_list` | List cloudflared tunnels in the account |
| `tunnel_create` | Create a remotely-managed tunnel (idempotent by name); returns its run token |
| `tunnel_token` | Get the run token for an existing tunnel |
| `tunnel_configure` | Set a tunnel's public-hostname ingress (hostname → local service) |
| `tunnel_delete` | Delete a tunnel by name |

### Stand up a tunnel end-to-end

```
tunnel_create   name=my-dev                                   → returns id + token
tunnel_configure name=my-dev hostname=dev.example.com service=http://localhost:8770
dns_create      type=CNAME name=dev.example.com content=<id>.cfargotunnel.com
# then run it locally (no cert.pem needed):
#   TUNNEL_TOKEN=<token> cloudflared tunnel run
```

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
