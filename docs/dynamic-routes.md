# `dynamic/{route-name}` - AI Gateway dynamic routes

A dynamic route is configured in the AI Gateway dashboard (conditional routing, per-node
timeouts, cross-model fallback) and needs no Worker deploy. Callers address it as the
literal model `dynamic/{route-name}`. See also `docs/invariants.md` (Model naming).

- Callers use a **nexus virtual key**, nothing else. The route resolves its own provider
  inside AI Gateway, so the Worker supplies the outbound credential: the `nvidia_nim` pool
  key in the bundled config (the `dynamic` entry names `NVIDIA_API_KEY`), which fits a route
  whose nodes are all `custom-nvidia`. **BYOK is refused here**, because a caller cannot
  know which provider the route will pick.
- **This works only while a route's nodes share ONE provider.** There is a single
  `Authorization` header on the hop, so a route mixing, say, NVIDIA and OpenRouter would send
  the NVIDIA key to both. That case needs AI Gateway stored keys (BYOK at the gateway
  itself), which this Worker does not use.
- **Extra body fields pass through verbatim** - AI Gateway rewrites only `model`. So
  `chat_template_kwargs: {enable_thinking: false}` reaches the node and turns reasoning off
  on models that honour it (a system-message `/no_think` does not). The control is
  **per-model, not per-route**: a route can land on any node, so thinking-off is only
  reliable while EVERY node honours the flag. On the Anthropic wire a `thinking` block comes
  back when the upstream reasons by default, not because the Worker asked: the `dynamic`
  entry declares no `reasoning` dialect, so `budget_tokens` is decorative. Add a dialect if
  it must be honoured.
- **The `fallback` edge is the GENERIC failure edge**, not a 429/5xx one. A deliberate 400
  from a bad parameter also ends on the fallback, so the error the caller sees is the
  FALLBACK's (a caller-side bad request looks like the fallback model is broken), and the
  primary's attempt may not appear in the AI Gateway logs at all. A node's `timeout` behaves
  as first-byte, not total, so a "3s primary" can log a 30s failure. Budget latency for the
  worst case, not the configured timeout.

## AI Gateway admin API (needs a Cloudflare API token, not the master key)

- dynamic routes: `GET /accounts/{acc}/ai-gateway/gateways/{gateway}/routes` - the path
  segment is `routes`, NOT `dynamic_routes` or `dynamic-routes`; those 404 with a bare
  "Route not found".
- one route's graph: `GET .../routes/{route_id}/versions/{version_id}`
- which node served: `GET .../gateways/{gateway}/logs?per_page=10&order_by=created_at&order_by_direction=desc`
  gives per-attempt model, status code and duration.
