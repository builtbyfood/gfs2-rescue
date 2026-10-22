# Steps reference

Every step except Attach runs on the host picked in the work panel, detached through `systemd-run`
as unit `gfs2-rescue-<wwid>`, so a long fsck survives the agent call and the browser. Attach runs on
the appliance. Before any step starts, the server scans every host of the cluster again and applies
the rules below to that fresh view, whatever the page showed.

"Unmounted" below means: not mounted, and its DLM lockspace not live, on any host of the cluster.

## Re-UUID

| | |
| --- | --- |
| Offered when | Another LUN carries the same filesystem UUID |
| Requires | Unmounted; not a Morpheus datastore; the "this LUN is the copy" box ticked and the WWID typed |
| Runs | `gfs2-rescue.sh reuuid /dev/mapper/<wwid> --yes` |
| Does | Backs up the first 128 KiB, sets a new random UUID with `tunegfs2 -U`, reads it back, asks udev to refresh |
| Writes to the volume | Superblock (UUID only) |
| Results | `ok` (detail: old → new UUID), `error` |
| Run folder | Starts a new one; the next Collect reuses it |

The script also refuses if the copy's DLM lockspace name is live on the host and the device that
owns it (the original, mounted on this host) cannot be found.

## Collect

| | |
| --- | --- |
| Requires | Unmounted |
| Runs | `gfs2-rescue.sh collect /dev/mapper/<wwid> --hash-under-mb 64` |
| Does | Records multipath, lsblk, superblock, journal count, the host's DLM cluster and lockspaces; saves the first 128 KiB; mounts read-only with `lockproto=lock_nolock`; lists every entry; hashes files under 64 MiB; reports qcow2 backing chains; unmounts |
| Writes to the volume | Nothing |
| Results | `ok` (detail: number of entries), `error` |
| Run folder | Starts a new one, unless the current one ended with a successful Re-UUID |

## Check

| | |
| --- | --- |
| Requires | Unmounted; a Collect in the current run |
| Runs | `gfs2-rescue.sh check /dev/mapper/<wwid>` |
| Does | `fsck.gfs2 -n`, then grades the output |
| Writes to the volume | Nothing |
| Results | `clean`, `tier1`, `tier2`, `tier3`, `error` |

Grading, from `fsck.gfs2 -n` output as a terminal would show it (progress redraws, colour codes
and blank lines are set aside first; anything unrecognised after pass 1b still counts as tier3):

| Result | Rule |
| --- | --- |
| tier3 | Level 1 resource group check not passed, or any finding from pass 1b onwards |
| tier2 | In pass 1: an inode block marked used but unowned (`bitmap says 2` or `3`), or `Inode count inconsistent` |
| tier1 | In pass 1: a data block marked used but unowned (`bitmap says 1`), `free count inconsistent`, or a wrong statfs file |
| clean | None of the above |

## Repair

| | |
| --- | --- |
| Offered when | The current run's last step is Check with tier1 or tier2 |
| Requires | Unmounted; a Collect in the run; snapshot box ticked and WWID typed |
| Runs | `gfs2-rescue.sh repair /dev/mapper/<wwid> --yes` |
| Does | Grades again; stops if clean (nothing to do) or tier3; `fsck.gfs2 -y`; grades again and requires clean; mounts read-only with local locking; walks against the manifest and hashes; unmounts |
| Writes to the volume | Yes (fsck repairs) |
| Results | `ok` (verified), `clean` (nothing to repair), `issues` (entries missing, changed or unreadable), `error` |

## Adopt

| | |
| --- | --- |
| Offered when | The lock table names another cluster, or another LUN shares this one's lock table |
| Requires | Unmounted; the hosts agree on one DLM cluster name; the current run's last step is a clean Check, a Repair with `ok` or `clean`, or a Repair with `issues` plus the "accept unreadable entries" tick; snapshot box ticked and WWID typed; a valid datastore name |
| Runs | `gfs2-rescue.sh adopt /dev/mapper/<wwid> --locktable <dlm>:<fsname> --yes [--allow-unreadable]` |
| Does | Records the superblock; checks with `fsck.gfs2 -n` and refuses unless clean; saves the superblock region if not saved yet; sets `lockproto=lock_dlm`; sets the lock table; reads it back |
| Writes to the volume | Superblock (lock protocol and lock table) |
| Results | `ok` (detail: lock table and journal count), `blocked` (fsck not clean), `error` |

The lock table is built on the server from the hosts' DLM cluster name and the datastore name, with
`-` written as `_`. The browser cannot supply a lock table. The server refuses a name that:

- is not 1–30 letters, digits, `-` or `_`, starting with a letter or digit,
- would produce a lock table another LUN in the cluster already has,
- is already the name of a Morpheus datastore (any type, compared without case).

## Attach

| | |
| --- | --- |
| Requires | The lock table names this cluster; no other LUN shares it; not already a Morpheus datastore; unmounted; the device present as a block device on every host of the cluster; an API credential set |
| Runs | On the appliance, through the Morpheus API |
| Does | Finds datastore type `libvirt-dir-gfs2`; checks its fields still include `blockDevice` and `allowReformat`; refuses if any datastore in the cluster already uses this device or this name; posts the new datastore with `allowReformat: false`; then the page rescans until Morpheus has mounted it |
| Writes to the volume | Nothing itself; Morpheus mounts it on every host |
| Results | `requested`, then `ok` once mounted (detail: datastore name and host count), `error` |

The datastore name is derived from the lock table (`_` shown as `-`). It cannot be changed at
Attach; to use another name, Adopt again with it.

The API calls are listed in [How it works](09-how-it-works.md#morpheus-api).

## Verify

| | |
| --- | --- |
| Requires | Mounted on the chosen host as GFS2 at `/mnt/<uuid>`; a Collect in that host's current run |
| Runs | `gfs2-rescue.sh verify /mnt/<uuid> <run folder>` |
| Does | Walks the mounted filesystem; compares type, size and path of every entry with the manifest; re-checks every recorded hash; lists unreadable entries |
| Writes to the volume | Nothing |
| Results | `ok` (all present and unchanged), `issues`, `error` |

## Step results in the tab

"Last step" in the work panel shows the step, its result and detail, and the time. Green is `ok`
or `clean`; red is `error`, `tier3` or `blocked`; anything else is amber. The result comes from
`state.json` in the current run folder on the chosen host, so switching hosts shows that host's run.
