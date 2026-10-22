# GFS2 Rescue for HPE Morpheus (HVM) 9.1

Lets an HVM cluster take over GFS2 shared storage created by another cluster, and attach it as an
HPE Clustered Datastore, **without reformatting it** and with proof that nothing on it was lost.

Use it to move storage from cluster to cluster (for example HVM 1.3 to HVM 2.0), to bring storage
back after a cluster rebuild or a lost appliance, to take over a replicated LUN for disaster
recovery, or to attach a snapshot next to its original and restore VMs from it.

It adds a **GFS2 Storage** tab to each cluster. For a volume you select, it runs a fixed sequence
on a host you choose, and every step is checked on the server against a fresh scan of the whole
cluster:

| Step | What it does | Writes to the volume |
| --- | --- | --- |
| Re-UUID | Only for a snapshot presented next to its original: a new filesystem UUID | Superblock |
| Collect | Superblock backup, manifest of every entry, hashes, qcow2 backing chains | No |
| Check | `fsck.gfs2 -n`, graded clean / tier1 / tier2 / tier3 | No |
| Repair | `fsck.gfs2 -y` for tier1/tier2 only, then a walk against the manifest | Yes |
| Adopt | Lock table rewritten to `<this cluster>:<datastore name>` | Superblock |
| Attach | HPE Clustered Datastore created through the Morpheus API, reformatting off | No |
| Verify | Every entry and hash on the mounted datastore compared with the manifest | No |

It works on GFS2 and nothing else: devices are confirmed GFS2 by probing their superblock, and only
HPE Clustered (GFS2) datastores are ever matched or created. It never formats, and never writes to
a volume that is mounted or whose lockspace is live anywhere in the cluster. It is off until an
administrator turns it on.

## Documentation

Full documentation is in [`docs/`](docs/README.md):

- [Overview](docs/01-overview.md)
- [Install and settings](docs/02-install-and-settings.md)
- [Takeover walkthrough](docs/03-takeover-walkthrough.md)
- [Steps reference](docs/04-steps-reference.md)
- [Safety rules](docs/05-safety.md), including [GFS2 only](docs/05-safety.md#gfs2-only)
- [Snapshots and duplicate UUIDs](docs/06-snapshots-and-duplicates.md)
- [Host script](docs/07-host-script.md)
- [Troubleshooting](docs/08-troubleshooting.md)
- [How it works](docs/09-how-it-works.md)
- [Demo LUN](docs/10-demo-lun.md)

## Quick start

```powershell
.\gradlew.bat clean shadowJar --no-daemon
# build\libs\morpheus-gfs2-rescue-<version>-all.jar
```

1. Administration → Integrations → Plugins → Add → upload the jar.
2. Plugin settings: tick **Enable GFS2 Rescue**; set **API token credential** to the name or ID of a
   Trust credential holding a Morpheus API token.
3. Infrastructure → Clusters → your cluster → **GFS2 Storage**.

Rehearse on a scratch LUN first ([Demo LUN](docs/10-demo-lun.md)), and turn the plugin off when the
takeover is done.

## Requirements

Morpheus 9.1.0+, HVM clusters, and GFS2 on multipath devices. Build pins match HPE's own 9.1 plugins: plugin-api 1.5.0,
morpheus-plugin-gradle 1.2.8, Groovy 4.0.31, Java 25, Gradle 9.x.

## Changes

See [CHANGELOG.md](CHANGELOG.md).
