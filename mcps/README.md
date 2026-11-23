# MCP servers

One file per server, named `<id>.mcp.yaml`. Add them with `mw mcp add`. A role gets a server when
the server lists the role under `roles:` (or says `roles: all`), or the role names it under `mcps:`.

```yaml
id: docs
description: Project documentation search
transport: http           # http | stdio
url: http://docs.example.com:5055/mcp
headers:
  Authorization: "Bearer ${NOTEBOOK_TOKEN}"   # secrets are always environment references
roles: [planner, worker]
```
