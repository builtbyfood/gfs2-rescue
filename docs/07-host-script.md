# Host script

The plugin does its host work through one script, `gfs2-rescue.sh`, which ships inside the jar and
is installed on each host as `/opt/gfs2-rescue/gfs2-rescue.sh` the first time the tab scans that
host. It works the same from a shell, which is how you finish or redo a takeover when the appliance
is down. The source is `src/main/resources/scripts/gfs2-rescue.sh`.

Run it as root. Every command that needs root needs its own `sudo`:

```
sudo /opt/gfs2-rescue/gfs2-rescue.sh inspect
```

## Commands

| Command | What it does |
| --- | --- |
| `inspect [--json]` | Lists every GFS2 volume this host sees (multipath maps, not their member paths): lock table, journals, mount point, whether its lockspace is live. Read-only. |
| `collect <dev> [--hash-under-mb N]` | Read-only evidence: superblock backup, manifest, hashes of files under N MiB, qcow2 backing chains. |
| `check <dev>` | `fsck.gfs2 -n`, graded clean / tier1 / tier2 / tier3. Read-only. |
| `repair <dev> [--yes]` | `fsck.gfs2 -y` for tier1/tier2, re-check, then a walk against the manifest. |
| `adopt <dev> --locktable CLUSTER:FSNAME [--yes] [--allow-unreadable]` | Rewrites the lock table. Refuses unless `fsck.gfs2 -n` is clean. |
| `reuuid <dev> [--yes]` | Gives a duplicate copy a new filesystem UUID. |
| `verify <mountpoint> <rundir>` | After the cluster mounts it: walk and hashes against the manifest. |
| `restore-sb <dev> <rundir>` | Writes the saved superblock region back. |
| `rescan` | SCSI and iSCSI rescan for new LUNs; no multipath reload. |
| `record <step> <result> [detail]` | Adds a result to the run's log and `state.json` (the plugin uses this for Attach). |
| `--version` | Prints the script version. |

Without `--yes`, repair, adopt, reuuid and restore-sb ask you to type a word (`REPAIR`, `SNAPSHOT`,
`REUUID`, `RESTORE`) before writing.

`<dev>` should be the multipath device, `/dev/mapper/<wwid>`. The script warns if it is not.

## Run folders

All steps of one takeover share a run folder, chosen by the `RUN` environment variable. The default
is a new folder `/var/lib/gfs2-rescue/<timestamp>` per command, so from a shell, set it once and
reuse it:

```
export RUN=/var/lib/gfs2-rescue/takeover-$(date +%Y%m%d)
sudo RUN=$RUN /opt/gfs2-rescue/gfs2-rescue.sh collect /dev/mapper/<wwid> --hash-under-mb 64
sudo RUN=$RUN /opt/gfs2-rescue/gfs2-rescue.sh check /dev/mapper/<wwid>
sudo RUN=$RUN /opt/gfs2-rescue/gfs2-rescue.sh adopt /dev/mapper/<wwid> --locktable <dlm name>:<fsname>
```

The plugin names its folders `/var/lib/gfs2-rescue/<wwid>-<timestamp>/` and keeps a symlink
`/var/lib/gfs2-rescue/<wwid>.current` pointing at the current one. To continue a plugin run from a
shell:

```
sudo RUN=$(sudo readlink -f /var/lib/gfs2-rescue/<wwid>.current) /opt/gfs2-rescue/gfs2-rescue.sh check /dev/mapper/<wwid>
```

Folders are `0700`, root only.

If the array gives a LUN a new WWID (a clone split from its parent, a volume presented again), the
tab finds no `<new wwid>.current` link. It then looks on that host for the newest run with a Collect
manifest for the same filesystem UUID, links it to the new WWID, and notes the change in its log, so
the evidence carries on with the filesystem. Two LUNs with the same UUID never do this.

| File | Written by | Contents |
| --- | --- | --- |
| `log.md` | every step | Every command run, its output and exit code, as Markdown |
| `fs-uuid` | collect | The filesystem UUID, so the run can follow the filesystem if the LUN's WWID changes |
| `state.json` | every step | The last step's result: version, step, result, detail, time, host |
| `sb-first-128k.img` | collect, adopt | The first 128 KiB of the device (superblock region) |
| `sb-before-reuuid-128k.img` | reuuid | The same, taken before the UUID change |
| `manifest-before.tsv` | collect | Type, size, modification time and path of every entry |
| `walk-before.err` | collect | Entries that could not be read before anything changed |
| `sha256-before.txt` | collect | Hashes of files under the size limit |
| `qcow2-chains.txt` | collect | Virtual size, disk size and backing file of every qcow2 image |
| `fsck-n.txt` | check, repair | `fsck.gfs2 -n` output |
| `fsck-y.txt` | repair | `fsck.gfs2 -y` output |
| `fsck-n-after.txt` | repair | The re-check after repairing |
| `fsck-n-adopt.txt` | adopt | The check Adopt runs before writing |
| `manifest-<label>.tsv` | repair, verify | The walk after repair (`after-repair`) or after takeover (`after`) |
| `missing-<label>.txt` | repair, verify | Entries in the manifest that are missing or changed |
| `unreadable-<label>.txt` | repair, verify | Entries listed by their directory whose inode cannot be read |
| `hashfail-<label>.txt` | repair, verify | Files whose hash no longer matches |
| `mnt/` | collect, repair | Temporary read-only mount point |

## Undoing a superblock change

Adopt and Re-UUID change only the superblock. To put the old one back, with the volume unmounted
everywhere:

```
sudo /opt/gfs2-rescue/gfs2-rescue.sh restore-sb /dev/mapper/<wwid> /var/lib/gfs2-rescue/<run folder>
```

It writes back the first 128 KiB saved by Collect or Adopt (`sb-first-128k.img`). After a Re-UUID,
the copy taken just before it is `sb-before-reuuid-128k.img`; to use it, copy it over
`sb-first-128k.img` in that folder first. For anything beyond the superblock, restore the array
snapshot.

## Finishing a takeover with the appliance down

1. `inspect` on a host to find the device and confirm its lock table.
2. `collect`, `check`, and `repair` if needed, with one `RUN`.
3. `adopt` with `--locktable <new DLM cluster name>:<fsname>`. The DLM cluster name is in
   `/sys/kernel/config/dlm/cluster/cluster_name` on a host of the new cluster; `fsname` must be the
   datastore name you will use in Morpheus, with `-` written as `_`.
4. When the appliance is back, add the datastore (Attach on the tab, or Morpheus's dialog with
   Allow Reformatting **unchecked**).
5. `verify <mountpoint> $RUN` once it is mounted.
