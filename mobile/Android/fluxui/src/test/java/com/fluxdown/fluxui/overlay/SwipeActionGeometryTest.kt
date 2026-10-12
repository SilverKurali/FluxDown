package com.fluxdown.fluxui.overlay

import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Test

class SwipeActionGeometryTest {
    @Test
    fun emptySideDoesNotReservePadding() {
        assertEquals(0, Density(1.25f).swipeActionRevealWidth(0, 0))
    }

    @Test
    fun fractionalDensityDoesNotTrimTheRevealedActionTray() {
        // 在 1.25 倍密度下，Compose 将每个 6dp 间距取整为 8px，
        // 不能把整盘 dp 宽度一次性取整，否则两个图标按钮会少露 1px。
        with(Density(1.25f)) {
            val plate = swipeActionWidth(false).dp.roundToPx()
            val revealed = swipeActionRevealWidth(2, 0)
            assertEquals(8, (revealed - 2 * plate) / 3)
            assertEquals(0, (revealed - 2 * plate) % 3)
        }
    }
}
