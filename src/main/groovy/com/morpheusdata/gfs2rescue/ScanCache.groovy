package com.morpheusdata.gfs2rescue

import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

/**
 * Last scan result per cluster, kept in memory, and one scan per cluster at a time (0.1.25).
 *
 *  - last(key): the last successful result, whatever its age, marked cached with its age.
 *    Reading it runs nothing on a host; the tab shows it when it is opened.
 *  - run(key, maxAgeMs, keep, work): returns the kept result if it is younger than maxAgeMs;
 *    otherwise joins a scan of the same key that is already running; otherwise runs `work` on
 *    the calling thread. So two requests never scan the same cluster at once.
 *
 * Only the tab's listing uses this. Step checks (status, start, Recover VMs) call
 * Gfs2RescueController.freshView directly and never read a kept result.
 *
 * No Morpheus types, so it can be tested on its own like Rules.
 */
class ScanCache {

    /** A kept result younger than this answers a scan that allows it (the tab reopened). */
    static final long FRESH_MS = 30000L
    /** Longest a joining request waits for the running scan. */
    static final long WAIT_MS = 600000L
    /** Kept results; the oldest is dropped beyond this. */
    static final int MAX_KEPT = 64

    private final ConcurrentHashMap<String, Map> kept = new ConcurrentHashMap<>()
    private final ConcurrentHashMap<String, CompletableFuture<Map>> running = new ConcurrentHashMap<>()

    /** The last kept result with cached/ageMs set, or null when there is none. */
    Map last(String key) {
        Map r = kept.get(key)
        return r == null ? null : mark(r, true, false)
    }

    /** Keep a successful result as the last one for this key. */
    void put(String key, Map result) {
        if (result == null || result.get('success') != true) return
        kept.put(key, result)
        if (kept.size() > MAX_KEPT) {
            String oldest = null
            long at = Long.MAX_VALUE
            for (Map.Entry<String, Map> e : kept.entrySet()) {
                long t = ((e.value.get('scannedAt') ?: 0L) as Number).longValue()
                if (t < at) { at = t; oldest = e.key }
            }
            if (oldest != null && oldest != key) kept.remove(oldest)
        }
    }

    /**
     * @param maxAgeMs a kept result younger than this is returned without scanning; 0 = always scan
     * @param keep     keep the result as the last one for this key
     * @param work     the scan; must return a Map (success: true to be kept)
     */
    Map run(String key, long maxAgeMs, boolean keep, Closure<Map> work) {
        if (maxAgeMs > 0L) {
            Map r = kept.get(key)
            if (r != null && age(r) < maxAgeMs) return mark(r, true, false)
        }
        CompletableFuture<Map> mine = new CompletableFuture<>()
        CompletableFuture<Map> other = running.putIfAbsent(key, mine)
        if (other != null) {
            try {
                return mark(other.get(WAIT_MS, TimeUnit.MILLISECONDS), false, true)
            } catch (ExecutionException ee) {
                throw (ee.cause ?: ee)
            }
        }
        long t0 = System.currentTimeMillis()
        try {
            Map r = new LinkedHashMap(work.call() ?: [:])
            long now = System.currentTimeMillis()
            r.put('scannedAt', now)
            r.put('scanMs', now - t0)
            if (keep) put(key, r)
            mine.complete(r)
            return mark(r, false, false)
        } catch (Throwable t) {
            mine.completeExceptionally(t)
            throw t
        } finally {
            running.remove(key, mine)
        }
    }

    private static long age(Map r) {
        return System.currentTimeMillis() - ((r.get('scannedAt') ?: 0L) as Number).longValue()
    }

    /** A copy for one response: the kept map itself is never handed out or changed. */
    private static Map mark(Map r, boolean cached, boolean shared) {
        Map out = new LinkedHashMap(r)
        out.put('cached', cached)
        out.put('shared', shared)
        out.put('ageMs', Math.max(0L, age(r)))
        return out
    }
}
