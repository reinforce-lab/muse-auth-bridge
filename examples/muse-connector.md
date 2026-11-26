# Example: registering the bridge as a Muse custom connector (sketch)

This is a shape sketch, not a generated connector file. After deploying
the bridge, create a custom connector whose entire credential is the
bridge's **read** token — that is the point of the bridge: one static
Bearer value is all the platform ever holds.

```yaml
name: auth-bridge
description: >
  Home sensor data via my Muse Auth Bridge. The bridge holds the vendor
  secrets and signs requests; this connector only presents a Bearer token.
base_url: https://muse-auth-bridge.<your-subdomain>.workers.dev
auth:
  type: bearer            # single static value — fits the credential model
  # value: stored via the platform's secure credential flow, never in files

tools:
  - name: qingping_devices
    method: GET
    path: /qingping/devices
    description: Latest CO2 / PM2.5 / temperature / humidity for all Qingping devices.

  - name: qingping_history
    method: GET
    path: /qingping/history
    query: [mac, start_time, end_time]   # unix seconds
    description: Historical readings for one device.

  - name: switchbot_devices
    method: GET
    path: /switchbot/devices
    description: List SwitchBot devices and infrared remotes.

  - name: switchbot_device_status
    method: GET
    path: /switchbot/devices/{id}/status
    description: Current status of one SwitchBot device.
```

Notes:

- Keep write tools (`/commands`, `/scenes/:id/execute`) in a *separate*
  connector registration that uses the write token, so the everyday
  read connector can never actuate anything even if misused.
- Never register the admin token in a connector. The breaker is operated
  by hand (curl) in an incident, not by the agent.
