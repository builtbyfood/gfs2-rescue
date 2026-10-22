# GFS2 Rescue documentation

GFS2 Rescue is a plugin for HPE Morpheus 9.1 (HVM clusters). It adds a **GFS2 Storage** tab to each
cluster that takes over a GFS2 volume created by another cluster and attaches it as an HPE
Clustered Datastore, without reformatting it and without losing anything on it: for cluster to
cluster migration, after a cluster rebuild or a lost appliance, for disaster recovery, or to
restore VMs from a snapshot. Every step is checked against a record of what was on the
volume before anything was changed.

It works on GFS2 and nothing else. It never formats, never touches NFS, directory, LVM or any
other storage, and never touches a GFS2 volume that is in use.

| Document | Read it when |
| --- | --- |
| [Overview](01-overview.md) | You want to know what problem this solves and what it will and won't do |
| [Install and settings](02-install-and-settings.md) | Building, installing, enabling, the API credential |
| [Takeover walkthrough](03-takeover-walkthrough.md) | You are about to take over a volume |
| [Steps reference](04-steps-reference.md) | You need the exact conditions, commands and results of a step |
| [Safety rules](05-safety.md) | You want to know what is refused and why, including the GFS2-only scope |
| [Snapshots and duplicate UUIDs](06-snapshots-and-duplicates.md) | Two LUNs carry the same filesystem, or you are working from a snapshot |
| [Host script](07-host-script.md) | The appliance is down, or you want to run a step from a shell |
| [Troubleshooting](08-troubleshooting.md) | Something is refused, stuck or failed |
| [How it works](09-how-it-works.md) | You are changing the plugin, or auditing it |
| [Demo LUN](10-demo-lun.md) | You want to rehearse a takeover on a scratch LUN first |
| [Screenshot list](images/SHOTLIST.md) | You are capturing the screenshots for these docs |

Version: this documentation describes plugin 0.1.22 and host script 1.1.
