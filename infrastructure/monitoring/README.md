# Operational health and optional monitoring

- API `/api/system/live`: process liveness only. Never interpret it as dependency health.
- API `/api/system/health`: PostgreSQL schema query and Redis ping; HTTP 503 if either fails.
- API `/api/system/readiness`: sanitized core/processing/publishing prerequisites. Core readiness
  does not require optional publishing credentials. Processing requires AI/render/recovery workers.
- Authenticated owner/admin `/api/system/overview` and diagnostics: full operational detail.
- Python `/live`: process liveness; `/health`: configuration/media tool prerequisites, HTTP 503 on
  missing tools or configuration. AI health reports whether a model has loaded; configuration alone
  does not prove that model download or a remote provider call will succeed.
- `npm run verify:health`: HTTP **and JSON** readiness assertions. Does not use jq. Requires Python 3.

Probes have bounded waits. `HEALTHCHECK_TIMEOUT_MS` configures the API's per-dependency timeout.
Database probe timeouts bound HTTP latency but cannot cancel an already executing driver query.
Storage probes use unique objects and attempt cleanup. Worker discovery uses bounded Redis SCAN
rather than blocking KEYS. Heartbeats are presence signals, not a guarantee a given job will succeed.

## Prometheus overlay

```sh
docker compose -f docker-compose.prod.yml -f docker-compose.monitoring.yml up -d
```

The blackbox exporter probes JSON readiness endpoints and exports actual Prometheus `probe_success`
metrics. Prometheus never scrapes JSON as metrics. Alerts distinguish failed readiness from a failed
monitor. No ports are published; use your secured operator network/port-forwarding to access Prometheus.
No Alertmanager/notification receiver is configured by this overlay; configure one before relying on
alert delivery. No queue-backlog time series is claimed: use the authenticated dashboard's live queue
counts until an authenticated metrics exporter is implemented. Add PostgreSQL/Redis exporters with
secrets managed outside Git if database/Redis time-series monitoring is needed.

Compose images/config have not been container-validated in the Arena sandbox (Docker unavailable).
