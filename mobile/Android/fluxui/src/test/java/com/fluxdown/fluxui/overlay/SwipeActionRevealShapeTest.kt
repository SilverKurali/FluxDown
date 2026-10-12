package com.fluxdown.fluxui.overlay

import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class SwipeActionRevealShapeTest {
    private fun bounds(offset: Float, width: Float = 320f, height: Float = 64f, rtl: Boolean = false): Rect =
        (SwipeActionRevealShape(offset).createOutline(
            Size(width, height),
            if (rtl) LayoutDirection.Rtl else LayoutDirection.Ltr,
            Density(1f),
        ) as Outline.Rectangle).rect

    @Test
    fun partialRevealDoesNotOverlapMovingTaskContent() {
        // 操作盘先于手指行程完全显现时，尾部的打开按钮曾透叠到复制按钮上。
        for (offset in listOf(-12f, -56f, -158f, 12f, 56f, 158f)) {
            val revealed = bounds(offset)
            val content = Rect(offset, 0f, 320f + offset, 64f)
            assertFalse("offset=$offset", revealed.overlaps(content))
            assertEquals(kotlin.math.abs(offset), revealed.width, 0f)
            assertEquals(64f, revealed.height, 0f)
        }
        assertEquals(Rect(264f, 0f, 320f, 64f), bounds(-56f))
        assertEquals(Rect(0f, 0f, 56f, 64f), bounds(56f))
    }

    @Test
    fun closedAndOverswipedActionsStayWithinTheirOwnRow() {
        assertEquals(Rect(0f, 0f, 0f, 64f), bounds(0f))
        assertEquals(Rect(0f, 0f, 280f, 48f), bounds(-400f, 280f, 48f))
        assertEquals(Rect(0f, 0f, 280f, 48f), bounds(400f, 280f, 48f))
    }

    @Test
    fun clippingUsesPhysicalDragCoordinatesInEitherLayoutDirection() {
        // 前景 absoluteOffset 与动作盘都使用同一物理坐标，不随 RTL 二次镜像。
        for (offset in listOf(-158f, -20f, 0f, 20f, 158f)) {
            assertEquals(bounds(offset), bounds(offset, rtl = true))
        }
    }
}
