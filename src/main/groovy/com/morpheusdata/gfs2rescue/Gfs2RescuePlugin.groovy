package com.morpheusdata.gfs2rescue

import com.morpheusdata.core.Plugin
import com.morpheusdata.model.OptionType
import com.morpheusdata.views.HandlebarsRenderer
import groovy.util.logging.Slf4j

/**
 * GFS2 Rescue - take over GFS2 shared storage left behind by a cluster that no longer exists.
 *
 * Adds a "GFS2 Storage" tab to every cluster. The tab lists each GFS2 volume the cluster's
 * hosts can see and drives the proven procedure from the bundled gfs2-rescue.sh:
 * (re-uuid, duplicates only) -> collect (read-only) -> check -> repair (only when needed) -> adopt
 * -> attach (Morpheus API, never reformats) -> verify.
 */
@Slf4j
class Gfs2RescuePlugin extends Plugin {

    static final String VERSION = '0.1.22'

    @Override
    String getCode() { return 'gfs2-rescue' }

    @Override
    void initialize() {
        // Must be first (renderer before any provider), as in vm-folders.
        this.renderer = new HandlebarsRenderer()

        this.name        = 'GFS2 Rescue'
        this.description = 'Take over GFS2 shared storage left behind by a cluster that is gone'
        this.author      = 'Travis DeLuca'
        this.version     = VERSION

        // Off by default: the tab, its script and every route stay disabled until an
        // administrator turns this on, and can be turned off again once the rescue is done.
        this.settings = [
            new OptionType(
                name         : 'Enable GFS2 Rescue',
                code         : 'gfs2-rescue-enabled',
                fieldName    : Settings.ENABLED,
                fieldLabel   : 'Enable GFS2 Rescue',
                fieldContext : 'config',
                inputType    : OptionType.InputType.CHECKBOX,
                defaultValue : 'off',
                displayOrder : 0,
                required     : false,
                helpText     : 'Shows the GFS2 Storage tab on clusters and allows its steps to run on hypervisor hosts through the Morpheus agent. Leave off except while taking over a GFS2 volume. Turning it off hides the tab and rejects every request; scripts and run folders already on hosts are left in place.'
            ),
            new OptionType(
                name         : 'API token credential',
                code         : 'gfs2-rescue-api-credential',
                fieldName    : Settings.API_CREDENTIAL,
                fieldLabel   : 'API token credential (name or ID)',
                fieldContext : 'config',
                inputType    : OptionType.InputType.TEXT,
                displayOrder : 1,
                required     : false,
                helpText     : 'Name or numeric ID of a Trust credential (Infrastructure > Trust > Credentials) holding a Morpheus API token: an API Key credential, or Username and Password with the token as the password. Used by the Attach step to add the datastore through the Morpheus API. The GFS2 Storage tab shows which credential it found. The token is never shown or logged.'
            ),
            new OptionType(
                name         : 'Appliance API URL',
                code         : 'gfs2-rescue-appliance-url',
                fieldName    : Settings.APPLIANCE_URL,
                fieldLabel   : 'Appliance API URL',
                fieldContext : 'config',
                inputType    : OptionType.InputType.TEXT,
                displayOrder : 2,
                required     : false,
                helpText     : 'Leave blank to use https://127.0.0.1 (the appliance itself). Set it to the appliance address if the API is not served on the loopback address.'
            )
        ]

        Settings settingsReader = new Settings(this, morpheus)
        HostRunner runner = new HostRunner(this, morpheus)
        this.controllers.add(new Gfs2RescueController(this, morpheus, runner, settingsReader))
        registerProvider(new Gfs2RescueClusterTabProvider(this, morpheus, settingsReader))
        // the tab's own <script> ran on 9.1, but tab HTML has lost scripts on older UIs;
        // this also loads gfs2-rescue.js on every page while the plugin is enabled
        registerProvider(new Gfs2RescueLoaderProvider(this, morpheus, settingsReader))

        log.info("GFS2 Rescue ${VERSION} initialized (bundled script sha256 ${runner.scriptSha})")
    }

    Boolean hasCustomRenderer() { return true }

    @Override
    void onDestroy() {}
}
