# Recover VMs

After a takeover (Adopt, Attach, Verify), the datastore is mounted on every host, but the VMs on it
are not defined on any host and Morpheus has no record of them. **Recover VMs** brings them into the
new cluster: it defines each VM from its own saved definition and imports it as a managed instance.
Each VM keeps its UUID, MAC addresses and disk serials, so the guest sees the same machine.

The card appears in the work panel of a volume that is attached as a datastore and mounted.
Nothing changes until you choose VMs and click **Define & import**.

## Steps

1. **Scan for VMs** (read-only). No host to choose first: every host that mounts the datastore sees
   the same files, so the scan reads them from one. It finds every libvirt definition on the
   datastore: `mvm-hb/` (a heartbeat datastore keeps VM definitions there) and any VM folder, keeping
   the newest readable copy per VM and skipping unreadable files (for example a stale entry left by a
   repair). At the same time it reads each host's capacity.
2. **Review.** For each VM the list shows name, UUID, vCPU and memory, MAC addresses, networks, and
   every disk's chain after the old cluster's mount (`/mnt/<old uuid>`) is rewritten to this one:
   - **ok**: every layer opens.
   - **repoint**: a lower layer still names the old mount and exists under the new one; Define fixes
     it with `qemu-img rebase -u` (header only, no data copied).
   - **missing / unreadable**: a layer is gone; the VM cannot be defined from this datastore and needs
     a backup restore.

   A VM can be selected only when it is an orphan with no problems. Shown but not selectable:
   already defined on a host of the cluster, already known to Morpheus (by UUID or name), or a
   missing layer.
3. **Place.** Each selected VM gets a **Host**, suggested by free memory: biggest VM first, each on
   the host with the most memory left, counting what running and stopped VMs reserve and what this
   batch has already placed. Change any of them, or click **Suggest placement** to redo the whole
   selection. If the VM's network or portgroup does not exist on its host, the row says so.
4. **Check capacity.** *Host capacity after this batch* shows, per host, memory reserved by running
   VMs, stopped VMs and this batch, the total if everything were started (as a percentage of the
   host's memory), and vCPUs against CPU threads. Over 90% is a warning and over 100% is flagged, but
   neither blocks the import: the VMs are imported powered off, so you can move or resize them before
   starting them.
5. **Group and environment.** The Morpheus group for the new instances, and optionally an
   environment code (for example `production`).
6. **Define & import.** Up to the batch size (setting **VM import batch size**, 1 to 3, default 1):
   - Each VM is defined, stopped, on its assigned host from its original definition, with disk paths
     rewritten and stale `<backingStore>` entries dropped. The written definition is kept in
     `/var/lib/gfs2-rescue/vms/` on that host.
   - The cluster is refreshed, and each VM is converted to a managed instance in the chosen group
     once Morpheus has discovered it (up to six minutes per batch), then the environment is set.
   - The card logs every step. If Morpheus has not discovered a VM yet, run a cluster refresh,
     then Scan and import again.

## Requirements

- The **API token credential** setting (the same one Attach uses).
- Root SSH is not needed: everything runs through the Morpheus agent, like the other steps.

## After import

Check each instance's plan and layout, recreate backup jobs and monitoring checks, and start the VMs
when you are ready. A guest that runs a Morpheus agent keeps checking in as its old server record:
set `MORPHEUS_API_KEY` in `/etc/morpheus/morpheus-node.conf` in the guest to the new server's key and
run `morpheus-node-ctl reconfigure` and `morpheus-node-ctl restart`.

## Host script

The same two operations from a shell, as root on a host (JSON output):

```
gfs2-rescue.sh vms /mnt/<datastore uuid>
gfs2-rescue.sh define-vm /mnt/<datastore uuid> /mnt/<datastore uuid>/<path>/<vm>.xml --yes
gfs2-rescue.sh capacity
```
