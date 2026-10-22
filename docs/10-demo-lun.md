# Demo LUN

`tools/gfs2-demo-orphan.sh` turns a scratch LUN into a GFS2 volume that looks like it was left
behind by a cluster that no longer exists, with known content, so you can rehearse a takeover end
to end before doing it on real data. It is not installed by the plugin; copy it to one host.

## What it does

```
sudo ./gfs2-demo-orphan.sh prepare /dev/mapper/<wwid> [--old-cluster NAME] [--fsname NAME] [--journals N] [--no-data] [--yes]
sudo ./gfs2-demo-orphan.sh show /dev/mapper/<wwid>
```

`prepare` decides by what is on the LUN (read from the superblock, not udev's cache):

- **Already GFS2:** it only rewrites the lock table to `<old cluster>:<fsname>`. Data is kept.
- **Completely blank** (no filesystem signature, no partitions): it creates GFS2 with that lock
  table and `--journals` journals (default 32, what Morpheus creates). It asks you to type `FORMAT`
  first unless `--yes`.
- **Anything else** (another filesystem, LVM, partitions): refused.

It also refuses if the LUN is mounted or its lockspace is live on the host, and if `--old-cluster`
is this cluster's own name.

Defaults: `--old-cluster` is a random 14-character name like the ones Morpheus generates,
`--fsname` is `demo_bay`.

Unless `--no-data`, it then mounts the volume locally and writes:

| Path | Purpose |
| --- | --- |
| `notes.txt` | When and where it was prepared |
| `demo-vm/demo-vm.xml` | A VM definition whose disk path is on the old cluster's mount |
| `demo-vm/disk-0.qcow2` | A 1 GiB qcow2 base image with 64 MiB written |
| `demo-vm/disk-0.qcow2-snap` | An overlay whose backing file points at `/mnt/<old uuid>/…`, the old cluster's mount: Collect reports it as a chain that needs fixing |
| `random.bin` | 32 MiB of random data |
| `SHA256SUMS` | Hashes of all of the above |

It records what it did in `/var/lib/gfs2-demo/<wwid>.info`, including the lock table the takeover
should end up with. `show` prints the current lock table and that record.

## Rehearsal

1. Present a small LUN (50–100 GB is plenty) to every host of the cluster.
2. If it is a Morpheus datastore, delete the datastore in Morpheus first, so it is unmounted
   everywhere.
3. On one host: `sudo ./gfs2-demo-orphan.sh prepare /dev/mapper/<wwid>`.
4. Optional: in Morpheus, try adding it as a datastore and see the lock table mismatch. Cancel; do
   not tick Allow Reformatting.
5. Do the [takeover walkthrough](03-takeover-walkthrough.md): Collect, Check, Adopt, Attach,
   Verify. Verify should report zero missing, unreadable and hash failures. This is also the run to
   capture the screenshots from; the list is in [images/SHOTLIST.md](images/SHOTLIST.md).
6. To rehearse again, delete the datastore in Morpheus and run `prepare` again: the LUN is GFS2
   now, so only the lock table is rewritten.

## Rehearsing the snapshot case

Take an array snapshot of the demo LUN after it is attached, and present the snapshot to the same
hosts. Rescan storage. Both LUNs should show **Duplicate UUID**, with Re-UUID offered only on the
snapshot. Then follow [Snapshots and duplicate UUIDs](06-snapshots-and-duplicates.md), adopting the
copy as `demo-bay-copy`.
