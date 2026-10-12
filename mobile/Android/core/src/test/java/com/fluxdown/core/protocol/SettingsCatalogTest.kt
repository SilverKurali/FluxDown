package com.fluxdown.core.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SettingsCatalogTest {
    private fun ok(key: String, value: String) = (SettingsCatalog.normalize(key, value) as Normalized.Ok).wire
    private fun rejected(key: String, value: String) = SettingsCatalog.normalize(key, value) is Normalized.Rejected

    @Test
    fun syncCatalogMatchesRustSpecCount() {
        // SYNC_SETTING_SPECS（native/protocol/src/settings.rs）：30 个 daemon 键 + 29 个偏好键 + 1 个集合范围键 = 60
        assertEquals(30, SettingsCatalog.daemonSyncNames.size)
        assertEquals(29, SettingsCatalog.syncedPreferenceKeys.size)
        assertEquals(SettingsCatalog.daemonSyncNames.size, SettingsCatalog.syncNameToDaemonKey.size)
    }

    @Test
    fun normalizesLikeDaemon() {
        assertEquals("true", ok("bt_enable_dht", " 1 "))
        assertTrue(rejected("bt_enable_dht", "yes"))
        assertEquals("512", ok("default_segments", "+512"))
        assertTrue(rejected("default_segments", "513"))
        assertTrue(rejected("default_segments", "1.0"))
        assertTrue(rejected("default_segments", " "))
        assertEquals("-1", ok("max_auto_retries", "-1"))
        assertEquals("1.5", ok("bt_seed_ratio_limit", "1.50"))
        assertEquals("2", ok("bt_seed_ratio_limit", "2.0"))
        assertTrue(rejected("bt_seed_ratio_limit", "-0.1"))
        assertTrue(rejected("bt_seed_ratio_limit", "NaN"))
        assertEquals("socks5", ok("proxy_type", " socks5 "))
        assertTrue(rejected("proxy_type", "ftp"))
        assertEquals("ask", ok("file_exists_behavior", " ask "))
        assertTrue(rejected("file_exists_behavior", "prompt"))
        assertTrue(rejected("domain_conn_caps", ""))
        assertTrue(rejected("no_such_key", "x"))
        assertEquals("a b", ok("proxy_host", " a b "))
    }

    @Test
    fun userAgentRejectsControlCharactersButAllowsTab() {
        assertEquals("UA\tx", ok("global_user_agent", "  UA\tx "))
        assertTrue(rejected("global_user_agent", "UA\nx"))
    }

    @Test
    fun mirrorBaseRequiresHttpsHost() {
        assertEquals("", ok("component_mirror_base", "  /"))
        assertEquals("https://m.example.com/gh", ok("component_mirror_base", "https://m.example.com/gh//"))
        assertTrue(rejected("component_mirror_base", "http://m.example.com"))
        assertTrue(rejected("component_mirror_base", "https://m.example.com/?q"))
        assertTrue(rejected("component_mirror_base", "https:///path"))
    }

    @Test
    fun writePlanRoutesSyncedDaemonKeysThroughPreferences() {
        val result = SettingsWritePlan.make(
            mapOf(
                "max_concurrent_tasks" to "8",
                "bt_seed_ratio_limit" to "1.5",
                "proxy_mode" to "manual",
                "download.keep_awake" to "true",
                "download.silent_skip_selection" to "1",
            ),
        )
        val plan = (result as SettingsWritePlan.Result.Ok).plan
        assertEquals(mapOf("proxy_mode" to "manual"), plan.daemon)
        assertEquals(JsonValue.of(8L), plan.syncedPreferences["download.max_concurrent_tasks"])
        assertEquals(JsonValue.of(1.5), plan.syncedPreferences["bt.seed_ratio_limit"])
        assertEquals(JsonValue.True, plan.syncedPreferences["download.keep_awake"])
        assertEquals("max_concurrent_tasks", plan.syncedDaemonKeys["download.max_concurrent_tasks"])
        // 目录外的偏好只写本机
        assertEquals(mapOf("download.silent_skip_selection" to JsonValue.True), plan.localPreferences)
        assertFalse(plan.isEmpty)
    }

    @Test
    fun writePlanRejectsWholeBatchOnAnyInvalidValue() {
        val result = SettingsWritePlan.make(mapOf("proxy_mode" to "manual", "bt_port_start" to "0"))
        assertTrue(result is SettingsWritePlan.Result.Rejected)
        assertNotNull(SettingsWritePlan.validatePreferenceKey(SettingsCatalog.customThemesScopeKey))
        assertTrue(SettingsCatalog.isSynced("appearance.custom_themes.my-theme"))
        assertFalse(SettingsCatalog.isSynced(SettingsCatalog.customThemesScopeKey))
    }

    @Test
    fun wireFromJsonCoversScalarsOnly() {
        assertEquals("true", SettingsCatalog.wireFromJson(JsonValue.True))
        assertEquals("3", SettingsCatalog.wireFromJson(JsonValue.Num("3")))
        assertEquals("1.5", SettingsCatalog.wireFromJson(JsonValue.Num("1.50")))
        assertEquals(null, SettingsCatalog.wireFromJson(JsonValue.Arr(emptyList())))
    }
}
