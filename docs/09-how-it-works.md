# How it works

## Components

| File | Role |
| --- | --- |
| `Gfs2RescuePlugin.groovy` | Entry point: version, settings form, registers the providers and controller |
| `Settings.groovy` | Reads the plugin settings (cached 15 s). Off unless explicitly on |
| `Gfs2RescueClusterTabProvider.groovy` | The **GFS2 Storage** cluster tab. Renders an empty shell with the cluster id and name; shown only while enabled |
| `Gfs2RescueLoaderProvider.groovy` | Global component that loads `gfs2-rescue.js` on every page while enabled (tab HTML loses its `<script>` tags) |
| `Gfs2RescueController.groovy` | The routes: guard, cluster and host loading, fresh scans, step start, Attach |
| `Rules.groovy` | Pure logic, no Morpheus types: merging host reports into volumes, duplicate detection, which steps may run and why not |
| `HostRunner.groovy` | Everything that touches a host: privilege mode, script deployment, inspect, status, start, record, rescan |
| `MorpheusApi.groovy` | The appliance's REST API for Attach, and the Trust credential lookup |
| `renderer/hbs/gfs2RescueClusterTab.hbs` | Tab markup and styles (light and dark) |
| `assets/javascript/gfs2-rescue.js` | The page: scan, tree, work panel, polling, step requests |
| `scripts/gfs2-rescue.sh` | The host script ([reference](07-host-script.md)) |
| `tools/gfs2-demo-orphan.sh` | Prepares a scratch LUN for rehearsal ([Demo LUN](10-demo-lun.md)) |

## Request flow

1. The tab renders a shell with `data-cluster-id`. `gfs2-rescue.js`, loaded on every page by the
   global component, notices it and starts.
2. The page POSTs `/plugin/gfs2Rescue/scan`. The controller loads the cluster's hypervisor hosts,
   and on each one: works out the privilege mode, makes sure the script is current, runs
   `inspect --json`, and lists active `gfs2-rescue-*` units. `Rules.merge` combines the reports;
   Morpheus datastores of type `libvirt-dir-gfs2` are matched by mount path.
3. Selecting a volume POSTs `/status` for the chosen host: the current run folder, `state.json`, the
   log tail, and `Rules.allowed` for that volume and host.
4. A step button POSTs `/start`. The controller scans the whole cluster again, applies
   `Rules.allowed` to the fresh view, validates every parameter, then starts the step on the host
   (or calls the API for Attach).
5. While a step runs the page polls `/status` every 5 seconds; when it ends, it rescans.

## Routes

All POST, all behind the same guard: plugin enabled, `admin-cm` full, core's CSRF token, header
`X-GR-Request`, same origin, authenticated user.

| Route | Parameters | Returns |
| --- | --- | --- |
| `/plugin/gfs2Rescue/scan` | `clusterId` | Cluster, hosts, volumes, warnings, API credential info |
| `/plugin/gfs2Rescue/rescan` | `clusterId` | Runs `rescan` on every host, then the same as scan |
| `/plugin/gfs2Rescue/status` | `clusterId`, `hostId`, `wwid`, `full` | Volume, run folder, state, log (40 lines, or all with `full=1`), allowed steps and reasons |
| `/plugin/gfs2Rescue/start` | `clusterId`, `hostId`, `wwid`, `step`, and per step `datastoreName`, `snapshot`, `confirm`, `allowUnreadable` | Started run, or the reason it was refused |

## Reaching the hosts

The same pattern as vm-folders, hvm-updater and Migration Assist:

- Commands go through the Morpheus agent with `executeCommandOnServer(server, cmd)`. The plugin has
  no SSH keys.
- The first call per host runs `id -u`. uid 0 runs commands directly; otherwise `sudo -n` is tried;
  if that is refused the host is marked unusable.
- Output is read from `TaskResult.data`, and success is judged by marker strings the command prints
  (`GR-OK`, `GR-STARTED=…`), never by the agent's success flag alone.
- Every value placed in a command is validated against a pattern by the controller and
  single-quoted by `HostRunner`.

### Script deployment

The script is read from the jar at startup, with any CR stripped, and hashed. On each host,
`/opt/gfs2-rescue/gfs2-rescue.sh` is hashed and compared. If it is missing or different, the
bundled copy is uploaded as 3,000-character base64 chunks, decoded on the host, and installed only
if its SHA-256 matches. The result is cached per host until the plugin restarts.

### Detached steps

Steps run as `systemd-run --unit gfs2-rescue-<wwid> --collect`, with `RUN` set to the run folder, so
a long fsck is independent of the agent call and the browser. The unit name doubles as a "one step
per volume" lock; the script also takes `flock` on the device.

## Morpheus API

Attach uses the appliance's REST API with a bearer token from the configured Trust credential:

| Call | Purpose |
| --- | --- |
| `GET /api/data-store-types?max=500` | Find type `libvirt-dir-gfs2`; confirm its fields include `blockDevice` and `allowReformat` |
| `GET /api/clusters/{id}/datastores?max=500` | Refuse a duplicate device or name; copy the `blockDevice` value format from existing GFS2 datastores |
| `POST /api/clusters/{id}/data-stores` | Create the datastore |

The POST body:

```json
{ "datastore": {
    "name": "demo-bay",
    "datastoreType": { "id": <libvirt-dir-gfs2 id> },
    "active": true,
    "defaultStore": false,
    "config": { "blockDevice": "<wwid or /dev/mapper/wwid>", "allowReformat": false } } }
```

The credential is resolved like Argus does it: `listById` (or a name filter), then
`loadCredentialConfig`. The secret is read from the password, token or key field and never logged.

## Naming rule

Morpheus derives a GFS2 datastore's lock table from its name: `<DLM cluster name>:<name>`, with `-`
written as `_` (datastore `vm-store` has lock table `…:vm_store`). GFS2 limits that part to 30
characters. The plugin therefore takes the name at Adopt, writes the lock table from it, and at
Attach derives the name back from the lock table (`_` shown as `-`), so the two cannot disagree.

## Duplicate detection

Volumes are keyed by multipath WWID. After merging, `Rules.markDuplicates` compares every pair:
same filesystem UUID sets `dupUuid`, same lock table sets `lockTableClash`. When two volumes share
a lock table and one is mounted, a live lockspace (which is named after the shared filesystem
name) is credited to the mounted one.

## Status of an Attach

Attach happens in Morpheus, not on a host, so the controller writes its outcome into the run on the
chosen host with `gfs2-rescue.sh record` (`requested` or `error`). When `/status` finds that record
and the datastore is mounted, it reports `ok` with the host count.

## Not verified on every appliance

- `computeServer.list` filtered by `serverGroup.id` (there is an in-memory fallback).
- Credential lookup by name (`accountCredential.list` with a name filter); lookup by ID is proven.
- `Datastore.owner` scoping for non-master tenants.
