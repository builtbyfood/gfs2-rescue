package com.morpheusdata.gfs2rescue

/**
 * Pure logic, no Morpheus types: merging what each host reports, and which steps may run.
 * The order of steps:
 *   (reuuid, only for a duplicate copy) -> collect -> check -> (repair, only for tier1/tier2 findings)
 *   -> adopt -> attach (Morpheus API) -> verify
 */
class Rules {

    static final java.util.regex.Pattern WWID      = ~/^[A-Za-z0-9_.-]{6,128}$/
    static final java.util.regex.Pattern LOCKTABLE = ~/^[A-Za-z0-9_-]{1,32}:[A-Za-z0-9_-]{1,30}$/
    static final java.util.regex.Pattern MOUNT     = ~/^\/mnt\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    static final List<String> STEPS = ['reuuid', 'collect', 'check', 'repair', 'adopt', 'attach', 'verify']
    /**
     * Datastore name <-> GFS2 lock table: Morpheus expects the part after the colon to be the
     * datastore name with '-' written as '_' (vm-store -> vm_store).
     * Names are limited to what maps exactly and fits GFS2's 30-character fsname.
     */
    static final java.util.regex.Pattern DSNAME = ~/^[A-Za-z0-9][A-Za-z0-9_-]{0,29}$/
    static String fsNameFor(String datastoreName) { datastoreName?.replace('-', '_') }
    static String suggestedName(String fsName) { fsName?.replace('_', '-') }

    /**
     * hostResults: [[host: [id,name], data: inspect JSON map, units: [wwid...]] ...]
     * Returns [clusterName, clusterNames (all seen), volumes: [...]] keyed by WWID (one row per LUN).
     * Keyed by WWID, not filesystem UUID: an array snapshot exported to the same hosts carries the
     * original's UUID, and keying by UUID merged the two LUNs into one row.
     */
    static Map merge(List<Map> hostResults) {
        // The Morpheus cluster record decides which hosts are asked. Their DLM cluster name is the
        // one most of them report; a host reporting another name is left out of everything below,
        // so the tab only ever shows and acts on the cluster it is loaded for.
        Map<String, Integer> counts = [:]
        hostResults.each { Map hr ->
            String hc = (hr.data as Map)?.hostCluster?.toString()
            if (hc) counts[hc] = (counts[hc] ?: 0) + 1
        }
        String cluster = null
        if (counts) {
            def top = counts.max { it.value }
            if (counts.values().count { it == top.value } == 1) cluster = top.key
        }
        List<Map> excluded = []
        Map<String, Map> vols = [:]
        hostResults.each { Map hr ->
            Map data = hr.data as Map
            if (!data) return
            Map h = hr.host as Map
            String hc = data.hostCluster?.toString()
            if (cluster && hc != cluster) { excluded << [id: h.id, name: h.name, hostCluster: hc]; return }
            (data.volumes ?: []).each { Map v ->
                String dev = v.device?.toString() ?: ''
                if (!dev.startsWith('/dev/mapper/')) return            // single paths are not handled
                if (!isGfs2(v)) return                                 // GFS2 only, whatever else a host reports
                String key = v.wwid?.toString()
                if (!key) return
                Map m = vols.get(key)
                if (m == null) {
                    m = [fsType: v.fsType, uuid: v.uuid, wwid: v.wwid, device: dev, size: v.size, lockTable: v.lockTable,
                         lockProto: v.lockProto, fsName: v.fsName, journals: v.journals,
                         seenOn: [], mountedOn: [], lockspaceOn: [], runningOn: []]
                    vols.put(key, m)
                }
                m.seenOn << [id: h.id, name: h.name]
                if (v.mountedAt) m.mountedOn << [id: h.id, name: h.name, mountpoint: v.mountedAt.toString()]
                if (v.lockspaceLive == true) m.lockspaceOn << [id: h.id, name: h.name]
                if ((hr.units ?: []).contains(v.wwid?.toString())) m.runningOn << [id: h.id, name: h.name]
            }
        }
        markDuplicates(vols.values() as List<Map>)
        vols.values().each { Map m ->
            String owner = m.lockTable?.toString()?.split(':', 2)?.getAt(0)
            m.ownerCluster = owner
            m.suggestedLockTable = (cluster && m.fsName) ? "${cluster}:${m.fsName}".toString() : null
            m.status = status(m, cluster)
        }
        return [clusterName: cluster, clusterNames: counts.keySet() as List, excludedHosts: excluded,
                volumes: vols.values().sort { it.device } as List]
    }

    /**
     * Two LUNs with one filesystem UUID (a snapshot exported to the same hosts): both are flagged and
     * every step but Re-UUID is refused on them. Two LUNs with one lock table (true for the same
     * reason, and still true after a Re-UUID): the copy must be adopted under a new name before it
     * can be attached. The DLM lockspace is named after the fsname they share, so a live lockspace
     * is credited to the member that is actually mounted, not to the unmounted copy.
     */
    static void markDuplicates(List<Map> vols) {
        vols.each { Map m -> m.dupUuidWith = []; m.lockTableClashWith = [] }
        vols.each { Map a ->
            vols.each { Map b ->
                if (a.is(b)) return
                if (a.uuid && a.uuid == b.uuid) (a.dupUuidWith as List) << b.device
                if (a.lockTable && a.lockTable == b.lockTable) (a.lockTableClashWith as List) << b.device
            }
        }
        vols.each { Map m ->
            m.dupUuid = !(m.dupUuidWith as List).isEmpty()
            m.lockTableClash = !(m.lockTableClashWith as List).isEmpty()
            if (m.lockTableClash && !(m.mountedOn as List) && (m.lockspaceOn as List)) {
                boolean otherMounted = vols.any { Map o -> !o.is(m) && o.lockTable == m.lockTable && (o.mountedOn as List) }
                if (otherMounted) { m.lockspaceOfOther = m.lockspaceOn; m.lockspaceOn = [] }
            }
        }
    }

    /** Only a superblock-probed GFS2 filesystem with a GFS2 lock protocol is ever shown or acted on. */
    static boolean isGfs2(Map v) {
        return v?.fsType == 'gfs2' && (v.lockProto?.toString() in ['lock_dlm', 'lock_nolock'])
    }

    /** One badge per volume. */
    static String status(Map m, String cluster) {
        if (m.runningOn) return 'running'
        if (m.dupUuid) return 'duplicate'
        if (cluster && m.ownerCluster == cluster) return 'match'
        if (m.mountedOn || m.lockspaceOn) return 'in-use'
        return 'foreign'
    }

    /**
     * Which steps may start for this volume on this host.
     * vol: merged volume; st: HostRunner.status() for the chosen host; hostId: chosen host.
     * Returns [allowed: [...], reasons: [step: why-not], needsAllowUnreadable: bool]
     */
    static Map allowed(Map vol, Map st, Long hostId, String cluster, boolean apiConfigured) {
        List<String> ok = []
        Map<String, String> why = [:]
        boolean running = (vol.runningOn as List) || st?.active
        if (running) {
            STEPS.each { why[it] = 'a step is running for this volume' }
            return [allowed: ok, reasons: why, needsAllowUnreadable: false]
        }
        boolean busy = (vol.mountedOn as List) || (vol.lockspaceOn as List)
        boolean manifest = st?.manifest == true
        Map state = (st?.state ?: [:]) as Map
        String last = state.step?.toString(), res = state.result?.toString()
        boolean mountedHere = (vol.mountedOn as List).any { (it.id as Long) == hostId }
        boolean belongs = cluster && vol.ownerCluster == cluster
        String dsName = (vol.datastore as Map)?.name?.toString()

        // everything that writes or mounts needs the volume unmounted everywhere
        String busyWhy = null
        if (busy) {
            String where = (((vol.mountedOn as List) + (vol.lockspaceOn as List)).collect { it.name }.unique().join(', '))
            busyWhy = dsName ? "in use as Morpheus datastore '${dsName}' (mounted on ${where})".toString()
                             : "mounted or its lockspace is live on: ${where}".toString()
        }

        // A duplicate filesystem UUID blocks everything except giving one copy a new UUID.
        if (vol.dupUuid) {
            // short: the warning at the top of the tab already names the pair
            String dupWhy = 'blocked: duplicate filesystem UUID (see the warning above); Re-UUID the copy first'
            (STEPS - 'reuuid').each { why[it] = dupWhy }
            if (busyWhy) why.reuuid = busyWhy + ' (Re-UUID the copy, not the volume in use)'
            else if (dsName) why.reuuid = "this is Morpheus datastore '${dsName}': Re-UUID the copy, not this one".toString()
            else ok << 'reuuid'
            return [allowed: ok, reasons: why, needsAllowUnreadable: false]
        }
        why.reuuid = 'only offered when two LUNs carry the same filesystem UUID'

        if (busyWhy) why.collect = busyWhy else ok << 'collect'

        if (busyWhy) why.check = busyWhy
        else if (!manifest) why.check = 'run Collect first'
        else ok << 'check'

        if (busyWhy) why.repair = busyWhy
        else if (!manifest) why.repair = 'run Collect first (repair checks its own result against the manifest)'
        else if (last == 'check' && res in ['tier1', 'tier2']) ok << 'repair'
        else if (last == 'check' && res == 'tier3') why.repair = 'structural findings: repair only on a clone of the array snapshot, with human review'
        else why.repair = 'run Check first; repair is offered only for tier1/tier2 findings'

        boolean needsAllow = (last == 'repair' && res == 'issues')
        boolean cleanRun = (last == 'check' && res == 'clean') || (last == 'repair' && res in ['ok', 'clean']) || needsAllow
        if (busyWhy) why.adopt = busyWhy
        else if (!cluster) why.adopt = 'hosts disagree on the cluster name (or none reported)'
        else if (belongs && !vol.lockTableClash) why.adopt = 'the lock table already belongs to this cluster'
        else if (cleanRun) ok << 'adopt'
        else why.adopt = 'needs a clean Check (or a verified Repair) in this run'

        // attach: add the datastore through the Morpheus API (never reformats)
        if (dsName) why.attach = "already attached as Morpheus datastore '${dsName}'".toString()
        else if (busyWhy) why.attach = busyWhy
        else if (!belongs) why.attach = 'Adopt first: the lock table must belong to this cluster'
        else if (vol.lockTableClash) why.attach = "another LUN (${(vol.lockTableClashWith as List).join(', ')}) has the same lock table: Adopt this one under a new datastore name first".toString()
        else if (vol.notSeenOn) why.attach = "not visible as a block device on: ${(vol.notSeenOn as List).join(', ')}. Morpheus needs it on every host: Rescan storage, then check multipath there".toString()
        else if (vol.uncheckedOn) why.attach = "could not check: ${(vol.uncheckedOn as List).join(', ')} (see Hosts). Morpheus needs the device on every host".toString()
        else if (!apiConfigured) why.attach = 'set "API token credential" in the plugin settings'
        else ok << 'attach'

        if (!manifest) why.verify = 'no Collect run on this host to compare against'
        else if (!mountedHere) why.verify = dsName ? 'not mounted on this host; pick a host it is mounted on'
                                                   : 'Attach it first; Verify runs once Morpheus has mounted it on this host'
        else ok << 'verify'

        return [allowed: ok, reasons: why, needsAllowUnreadable: needsAllow]
    }
}
