package com.morpheusdata.gfs2rescue

import com.morpheusdata.core.AbstractGlobalUIComponentProvider
import com.morpheusdata.core.MorpheusContext
import com.morpheusdata.core.Plugin
import com.morpheusdata.model.Account
import com.morpheusdata.model.User
import com.morpheusdata.views.HTMLResponse
import com.morpheusdata.views.ViewModel
import groovy.util.logging.Slf4j

/**
 * Puts a small inline, nonced watcher on every page (hbs/gfs2RescueLoader).
 * Tab providers hand their HTML to the UI as trusted HTML, which strips <script> tags
 * (found in the VME migration plugin, May 2026); a GlobalUIComponentProvider's template keeps
 * nonced scripts (vm-folders' VmFoldersNavProvider). The watcher waits for a #gr-root element
 * (the GFS2 Storage tab) to become visible, and only then loads gfs2-rescue.js. Until the tab is
 * opened a page makes no request for this plugin. show() and renderTemplate() only read the
 * cached settings.
 */
@Slf4j
class Gfs2RescueLoaderProvider extends AbstractGlobalUIComponentProvider {

    Plugin plugin
    MorpheusContext morpheusContext
    Settings settings

    Gfs2RescueLoaderProvider(Plugin plugin, MorpheusContext morpheusContext, Settings settings) {
        this.plugin = plugin
        this.morpheusContext = morpheusContext
        this.settings = settings
    }

    @Override String getCode() { return 'gfs2-rescue-loader' }
    @Override String getName() { return 'GFS2 Rescue Script Loader' }
    @Override Plugin getPlugin() { return plugin }
    @Override MorpheusContext getMorpheus() { return morpheusContext }
    @Override Boolean show(User user, Account account) { return settings.enabled() }

    @Override
    HTMLResponse renderTemplate(User user, Account account) {
        try {
            ViewModel<Map> model = new ViewModel<>()
            model.object = [version: Gfs2RescuePlugin.VERSION]
            return getRenderer().renderTemplate('hbs/gfs2RescueLoader', model)
        } catch (e) {
            log.error("GFS2 Rescue loader failed: ${e.message}", e)
            return HTMLResponse.success('')
        }
    }
}
