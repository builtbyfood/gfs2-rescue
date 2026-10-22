# Safety rules

The tab greys out buttons and explains why, but none of that is relied on. Every rule here is
enforced on the server when a step is started, against a fresh scan of every host, and most are
enforced a second time by the script on the host.

## GFS2 only

The plugin only ever shows, selects or acts on GFS2 filesystems and HPE Clustered (GFS2)
datastores. Everything else a host or the appliance reports is dropped before it reaches the page.

| Where | What is checked |
| --- | --- |
| Host script, finding volumes | A device is listed only if udev reports it as GFS2 **and** probing its superblock directly (`blkid -p`) confirms GFS2. A stale udev entry for a LUN that has since been reformatted as something else is skipped. |
| Host script, before any step | The device must be a block device whose superblock probes as GFS2. |
| Host script, Verify | The path must be a mounted filesystem of type `gfs2`. |
| Server, merging host reports | A volume is kept only if the script reported it as superblock-probed GFS2 with a GFS2 lock protocol (`lock_dlm` or `lock_nolock`), and only on a multipath device (`/dev/mapper/…`). |
| Server, before any step | The selected volume must still pass the same GFS2 test. |
| Server, matching datastores | A volume is matched only to Morpheus datastores of type `libvirt-dir-gfs2` (HPE Clustered Datastore). NFS, directory and every other datastore type are ignored. |
| Attach | The datastore is created as type `libvirt-dir-gfs2`, and the device-value format is copied only from other GFS2 datastores. |
| Rescan storage | Asks the hosts' SCSI and iSCSI layers to look for new LUNs. It is host-wide by nature (it cannot be limited to one LUN) but it only discovers devices; it does not mount, change or attach anything. |

Two checks deliberately look at every datastore type, because they are guards rather than actions:
Adopt refuses a datastore name already used by any datastore, and Attach refuses if any datastore
in the cluster already uses the device.

## Never format

- There is no format step in the plugin or the host script.
- Attach always sends `allowReformat: false`.
- A `/start` request carrying `allowReformat`, `reformat` or `format`, with any value, is rejected.
- `tools/gfs2-demo-orphan.sh` creates GFS2 only on a LUN with no filesystem signature at all, and
  refuses anything else.

## Never write to a volume in use

Re-UUID, Collect, Check, Repair, Adopt and Attach are refused while the volume is mounted, or its
DLM lockspace is live, on any host of the cluster. The script repeats the mount and lockspace check
on the host it runs on.

Mounts are matched by device number, not filesystem UUID. Matching by UUID would treat an unmounted
snapshot as mounted whenever its original is. A lockspace is matched by filesystem name, which a
snapshot shares with its original; when one of the two is mounted, the live lockspace is credited
to the mounted one.

## Only this cluster

- Hosts come from the Morpheus cluster record, not from what the storage can see.
- The DLM cluster name is the one most hosts report. A host reporting another name is listed as
  left out, contributes no volumes, and nothing runs on it. If the hosts tie, Adopt is disabled.
- Adopt always writes a lock table that starts with that DLM name.
- The tab only lists volumes the cluster's hosts can see, and a step only runs on a host that can
  see the volume.

## Evidence before changes

- Repair needs a Collect in the same run, because it checks its own result against the manifest.
- Repair is only offered for tier1 and tier2 findings. Tier3 stops for human review on a clone.
- Adopt needs a clean Check, or a Repair that verified (or whose unreadable entries you accepted),
  in the same run. It runs `fsck.gfs2 -n` again itself and refuses unless clean.
- Every writing step saves the superblock region first (Collect, Adopt or Re-UUID), so a bad
  superblock write can be undone with `restore-sb`.

## Explicit confirmation for every write

Repair, Adopt and Re-UUID need the snapshot box ticked and the WWID typed exactly. The browser
asks once more with the device, host and (for Adopt) the new lock table. The server checks the tick
and the WWID itself.

## One thing at a time

One step per volume: the systemd unit `gfs2-rescue-<wwid>` must not be active, and the script holds
a lock on the device for the whole step.

## Duplicate filesystems

If two LUNs share a filesystem UUID, nothing but Re-UUID runs on either, and Re-UUID never on the
one that is mounted or is a Morpheus datastore. If two LUNs share a lock table, Attach is refused
until one is adopted under its own name. See [Snapshots and duplicate UUIDs](06-snapshots-and-duplicates.md).

## Access

- Off by default; while off, the tab is hidden, no script is injected into pages and every route
  answers 403.
- Routes accept POST only, need `admin-cm` at full access, core's CSRF token, the `X-GR-Request`
  header and a same-origin request.
- Clusters, hosts and datastores are filtered to what the user's tenant can access.
- Every value placed in a host command is validated against a pattern and single-quoted.
- The script on each host is compared by SHA-256 with the copy in the plugin and replaced if
  different; an upload is installed only if its hash matches.
- Every step start is logged on the appliance with the user, device, host and result.
- The API token is never logged, shown or sent to the browser.
