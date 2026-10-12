package com.fluxdown.app.shell

import com.fluxdown.app.nav.AppTab
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class RootTabsTest {
    @Test
    fun visibleRssUsesOnlyTheFourRootDestinations() {
        assertEquals(
            listOf(AppTab.Downloads, AppTab.Rss, AppTab.Devices, AppTab.Settings),
            rootTabs(showRss = true, selected = AppTab.Downloads),
        )
    }

    @Test
    fun hiddenRssIsNotASwipeDestination() {
        val tabs = rootTabs(showRss = false, selected = AppTab.Downloads)
        assertEquals(listOf(AppTab.Downloads, AppTab.Devices, AppTab.Settings), tabs)
        assertEquals(AppTab.Devices, tabs[1])
        assertFalse(AppTab.Rss in tabs)
    }

    @Test
    fun explicitRssNavigationRemainsReachableButLeavingRemovesHiddenPage() {
        val onRss = rootTabs(showRss = false, selected = AppTab.Rss)
        val onDevices = rootTabs(showRss = false, selected = AppTab.Devices)
        assertEquals(AppTab.Rss, onRss[1])
        assertEquals(AppTab.Devices, onRss[2])
        assertEquals(AppTab.Devices, onDevices[1])
        assertFalse(AppTab.Rss in onDevices)
    }
}
