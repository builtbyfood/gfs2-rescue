# Troubleshooting

Start with the reason shown under a greyed-out button, then the step's log in the work panel. For
anything the page does not explain, look for `GFS2 Rescue` lines in the appliance log:

```
sudo grep 'GFS2 Rescue' /var/log/morpheus/morpheus-ui/current | tail -50
```

## The tab

**There is no GFS2 Storage tab.** The plugin is off. Plugin settings → tick Enable GFS2 Rescue →
save, then reload the cluster page (allow up to 15 seconds for the setting to be re-read).

**The tab says "Asking each host…" and never finishes.** The page script did not load. Reload the
page with the cache bypassed (Ctrl+F5). If it persists, check the jar contains
`assets/gfs2-rescue.js` ([Install](02-install-and-settings.md#build)).

**"rejected by the CSRF check (reload the page)".** The page's security token went stale, usually
after a long idle period or an appliance restart. Reload.

**A request answers "GFS2 Rescue is turned off in its plugin settings".** It was turned off while
the page was open. Turn it on again, or reload to hide the tab.

**"GFS2 Rescue failed to load. See the appliance log."** The tab template failed to render. The
appliance log has the exception.

## Hosts

**Script shows `failed`.** The upload to `/opt/gfs2-rescue` failed or its hash did not match. The
Problem column has the reason. Check free space and that `/opt` is writable, then Rescan.

**"reports DLM cluster X, not Y: left out".** That host belongs to a different DLM cluster from the
rest, for example an old-cluster host still in this Morpheus cluster record. Nothing runs on it.
Remove it from the cluster or fix its cluster configuration.

**"The hosts do not agree on a DLM cluster name; Adopt is disabled".** The hosts are split evenly
between names, so the plugin cannot tell which is this cluster. Fix the cluster first.

## Volumes

**A LUN is missing from the list.**

- Click **Rescan storage** to have each host look for new LUNs.
- Check on a host that it is a multipath device: `sudo multipath -ll`. Single-path devices are not
  listed.
- Check it really is GFS2: `sudo blkid -p /dev/mapper/<wwid>`. Only volumes whose superblock is
  GFS2 are listed, even if udev still has an older record saying otherwise.
- Check the host is not left out (Hosts table).

**"Duplicate UUID" on two volumes.** A snapshot or clone is presented to the same hosts as its
original. See [Snapshots and duplicate UUIDs](06-snapshots-and-duplicates.md).

**"Journals / hosts" is red: fewer than hosts.** Each host mounting GFS2 needs its own journal. After
Attach, add journals on one host with `sudo gfs2_jadd -j <count> /mnt/<uuid>`. The plugin does not
do this for you.

## Steps refused

**"mounted or its lockspace is live on: …".** The volume is in use somewhere in the cluster. If it
should not be, unmount it there. A lockspace that stays live after unmount usually means the host
lost cluster quorum and DLM cannot release it; restore quorum (`sudo corosync-quorumtool`) before
anything else.

**"in use as Morpheus datastore 'X'".** It is already attached and mounted. Only Verify runs on it.

**"run Collect first" / "no Collect run on this host to compare against".** The run folder with the
evidence is on the host you used for Collect. Pick that host in **Run on host**, or Collect again.

**"needs a clean Check (or a verified Repair) in this run".** The current run's last step is not one
Adopt accepts. Run Check (and Repair if offered) on the same host.

**"structural findings: repair only on a clone of the array snapshot, with human review".** Check
found tier3. The plugin will not repair it. Present a clone of the snapshot to a scratch host, try
`fsck.gfs2 -y` there, and compare the result with the Collect manifest before deciding.

**Adopt: "… already uses lock table …: choose another datastore name".** Another LUN in the cluster
already has the lock table this name produces. Pick another name.

**Adopt: "a Morpheus datastore named 'X' already exists".** Pick another name.

**Attach: "Adopt first: the lock table must belong to this cluster".** Run Adopt.

**Attach: "another LUN … has the same lock table".** This is a copy that still shares its original's
lock table. Adopt it under its own name.

**Attach: "not visible as a block device on: …".** Morpheus checks the device on every host when it
creates the datastore, so Attach waits until all of them have it. On each host named:

```
sudo multipath -ll <wwid>
sudo ls -l /dev/mapper/<wwid>
sudo dmsetup info <wwid>
```

A missing map usually means the LUN is not presented to that host, or multipathd has not picked it
up: click Rescan storage. A map with no active paths, or one left over from an earlier LUN with the
same WWID (an array clone re-created in place), needs `sudo multipath -f <wwid>` and then Rescan
storage, with nothing on that host using it.

**Attach: "could not check: …".** That host's scan failed (see Hosts). Fix that first.

**Attach: "set "API token credential" in the plugin settings".** No credential is configured.

## Attach errors

**"Trust credential 'X' not found".** The name or ID in the plugin settings does not match a
credential. The tab header shows what was looked up.

**"more than one Trust credential is named 'X': use its numeric ID".** Use the ID.

**"looking up 'X' by name failed (…): use its numeric ID".** Lookup by name is not available on this
appliance. Use the numeric ID (it is in the credential's edit link).

**"HTTP 401" or "HTTP 403".** The token is wrong, expired, or belongs to a user who cannot add
datastores. Create a new token for an administrator and update the credential.

**Connection refused or a timeout.** The API is not answering at the Appliance API URL. Set it to the
appliance's own address in the plugin settings.

**"datastore type libvirt-dir-gfs2 fields changed …; refusing to guess".** A Morpheus upgrade changed
the HPE Clustered Datastore form. The plugin will not send a request it cannot verify; it needs
updating for that version.

**"datastore 'X' already uses this device".** Morpheus already has a datastore on this LUN, possibly
one that is not mounted. Check the cluster's Storage tab.

**Morpheus: "Unable to prepare datastore: Device /dev/mapper/… not found on <host>".** The device
was not usable on that host when Morpheus created the datastore. Morpheus leaves an offline
datastore record and a "Datastore Offline" alarm. Fix the host as above, delete the offline
datastore in Morpheus (it never mounted), then Attach again.

**Attach requested, but the datastore never mounts (36 checks, about 6 minutes).** Look at the
cluster's history in Morpheus for the datastore task. The usual cause is a lock table that does not
match the datastore name; the plugin prevents that, so check the Morpheus log for the actual error.

## Step results

**"This LUN's identity (WWID) changed … continuing the run in …".** The array presents the
filesystem under a new WWID. The tab found the earlier run for the same filesystem on this host and
continues it. Nothing to do; Verify works as usual.

**Check → tier1 or tier2.** Expected after an unclean shutdown of the old cluster. Run Repair.

**Repair → issues.** The repair freed something a directory still pointed to, or a file changed.
The log lists each entry. Restore those files from another copy if they matter. To go ahead
anyway, tick "Accept the unreadable entries the repair left" at Adopt.

**Adopt → blocked.** `fsck.gfs2 -n` was not clean when Adopt ran it, even though an earlier Check
was. Something changed the volume in between. Stop and find out what before going further.

**Verify → issues with "Stale file handle".** A directory entry names an invalid inode. Do not delete
it while mounted. Take the datastore offline (unmounted on every host) and run `fsck.gfs2 -y`
from a shell.

## Morpheus's own messages

**"Locktable mismatch … or allow reformatting"** in Morpheus's Add Data Store dialog. That is the
situation this plugin exists for. Do not tick Allow Reformatting. Use the GFS2 Storage tab.
