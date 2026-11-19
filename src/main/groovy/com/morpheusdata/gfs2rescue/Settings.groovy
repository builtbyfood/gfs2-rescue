package com.morpheusdata.gfs2rescue

import com.morpheusdata.core.MorpheusContext
import com.morpheusdata.core.Plugin
import groovy.json.JsonSlurper
import groovy.util.logging.Slf4j

/**
 * Plugin settings (Administration -> Integrations -> Plugins -> GFS2 Rescue -> settings).
 * Read through MorpheusContext.getSettings(plugin) as JSON, cached briefly because the
 * loader's show() runs on every page render and the tab's show() on every cluster page: neither
 * waits on anything but this cached read. Checkbox values arrive as 'on'/'off' strings.
 */
@Slf4j
class Settings {

    static final String ENABLED = 'enabled'
    static final String API_CREDENTIAL = 'apiCredentialId'
    static final String APPLIANCE_URL = 'applianceUrl'
    static final String BATCH = 'importBatchSize'
    static final String SCAN_ON_OPEN = 'scanOnOpen'
    static final long TTL_MS = 15000L

    final MorpheusContext morpheus
    final Plugin plugin
    private volatile Map cache = null
    private volatile long cachedAt = 0L

    Settings(Plugin plugin, MorpheusContext morpheus) {
        this.plugin = plugin
        this.morpheus = morpheus
    }

    /** Off unless an administrator turned it on. Any read error counts as off. */
    boolean enabled() {
        def v = read()[ENABLED]
        return v == true || v?.toString()?.trim()?.toLowerCase() in ['on', 'true', '1', 'yes']
    }

    /**
     * Off (default): opening the tab shows the last scan and waits for Scan now.
     * On: the tab scans the hosts the first time it is opened. Never on page load either way.
     */
    boolean scanOnOpen() {
        def v = read()[SCAN_ON_OPEN]
        return v == true || v?.toString()?.trim()?.toLowerCase() in ['on', 'true', '1', 'yes']
    }

    /** Numeric ID or name of the Trust credential that holds a Morpheus API token. */
    String apiCredentialId() { read()[API_CREDENTIAL]?.toString()?.trim() ?: null }

    /** Base URL for the appliance's own API; default https://127.0.0.1. */
    String applianceUrl() { read()[APPLIANCE_URL]?.toString()?.trim() ?: null }

    /** VMs defined and imported per batch on the Recover VMs screen: 1 to 3, default 1. */
    int batchSize() {
        def v = read()[BATCH]?.toString()?.trim()
        int n = v?.isInteger() ? (v as int) : 1
        return Math.max(1, Math.min(3, n))
    }

    private Map read() {
        long now = System.currentTimeMillis()
        Map c = cache
        if (c != null && (now - cachedAt) < TTL_MS) return c
        Map out = [:]
        try {
            def raw = morpheus.getSettings(plugin)?.blockingGet()
            if (raw) {
                def parsed = new JsonSlurper().parseText(raw as String)
                if (parsed instanceof Map) out = parsed as Map
            }
        } catch (ex) {
            log.debug("GFS2 Rescue: settings unreadable (${ex.message}); treating as off")
        }
        cache = out
        cachedAt = now
        return out
    }
}
