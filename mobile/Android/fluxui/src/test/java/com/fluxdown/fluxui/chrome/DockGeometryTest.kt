package com.fluxdown.fluxui.chrome

import kotlin.math.roundToInt
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DockGeometryTest {
    private fun assertCoverage(geometry: DockGeometry, width: Int) {
        for (rtl in listOf(false, true)) {
            var edge = 0
            val order = if (rtl) geometry.widths.indices.reversed() else geometry.widths.indices
            for (i in order) {
                assertEquals("tab $i, rtl=$rtl", edge, geometry.left(i, rtl))
                assertTrue(geometry.widths[i] >= 0)
                edge += geometry.widths[i]
            }
            assertEquals(width, edge)
            assertTrue(geometry.indicatorLeft(rtl) >= 0)
            assertTrue(geometry.indicatorWidth >= 0)
            assertTrue(geometry.indicatorLeft(rtl) + geometry.indicatorWidth <= width)
        }
    }

    @Test
    fun selectedLabelUsesNaturalWidthAndOtherTabsFillEveryRemainingPixel() {
        for (count in listOf(3, 4)) {
            val preferred = IntArray(count) { 92 + it * 13 }
            for (width in listOf(300, 301, 480, 901)) {
                for (selected in 0 until count) {
                    val geometry = DockGeometry(count)
                    geometry.update(width, width, 48, preferred, FloatArray(count) { if (it == selected) 1f else 0f }, selected, false, 0f)
                    assertCoverage(geometry, width)
                    assertEquals(preferred[selected], geometry.widths[selected])
                    assertTrue(geometry.widths.all { it >= 48 })
                    val unselected = geometry.widths.filterIndexed { i, _ -> i != selected }
                    assertTrue(unselected.max() - unselected.min() <= 1)
                    for (rtl in listOf(false, true)) {
                        assertEquals(geometry.left(selected, rtl), geometry.indicatorLeft(rtl))
                        assertEquals(geometry.widths[selected], geometry.indicatorWidth)
                    }
                }
            }
        }
    }

    @Test
    fun iconOnlyTabsDivideFullWidthIncludingNarrowScreensAndHiddenRss() {
        for (count in listOf(3, 4)) {
            for (width in listOf(0, 24, 48, 131, 191, 192, 193, 239, 301, 900)) {
                for (selected in 0 until count) {
                    val geometry = DockGeometry(count)
                    geometry.update(width, width, 48, IntArray(count) { 900 }, FloatArray(count) { if (it == selected) 1f else 0f }, selected, true, 0f)
                    assertCoverage(geometry, width)
                    assertTrue(geometry.widths.max() - geometry.widths.min() <= 1)
                    if (width >= count * 48) assertTrue(geometry.widths.all { it >= 48 })
                    assertEquals(geometry.starts[selected], geometry.indicatorStart)
                    assertEquals(geometry.widths[selected], geometry.indicatorWidth)
                }
            }
        }
    }

    @Test
    fun indicatorInterpolatesMeasuredTabEdgesInsteadOfAnIndependentStride() {
        val geometry = DockGeometry(4)
        geometry.update(300, 300, 48, intArrayOf(108, 108, 108, 132), floatArrayOf(0.5f, 0f, 0f, 0.5f), 3, false, 0f)
        assertArrayEquals(intArrayOf(82, 60, 60, 98), geometry.widths)
        assertArrayEquals(intArrayOf(0, 82, 142, 202), geometry.starts)
        assertEquals(101, geometry.indicatorStart)
        assertEquals(90, geometry.indicatorWidth)
        assertEquals(109, geometry.indicatorLeft(true))
        assertCoverage(geometry, 300)
    }

    @Test
    fun selectionAndMiniAnimationsCoverAllPixelsAtFractionalDensities() {
        for (density in listOf(0.75f, 1f, 1.1f, 1.25f, 1.5f, 2.625f, 3.5f)) {
            val pad = (4 * density).roundToInt()
            val height = (56 * density).roundToInt()
            val item = (48 * density).roundToInt()
            for (count in listOf(3, 4)) {
                for (availableDp in listOf(180, 320, 393, 768)) {
                    val available = (availableDp * density).roundToInt()
                    val reserved = (68 * density).roundToInt()
                    val expanded = dockWidth(available, reserved, height, 0f) - pad * 2
                    val preferred = IntArray(count) { ((80 + it * 13) * density).roundToInt() }
                    for (from in 0 until count) for (selected in 0 until count) {
                        for (progress in listOf(0f, 0.13f, 0.5f, 0.87f, 1f)) {
                            val weights = FloatArray(count)
                            weights[from] += 1f - progress
                            weights[selected] += progress
                            for (mini in listOf(0f, 0.17f, 0.5f, 0.83f, 1f)) {
                                val width = dockWidth(available, reserved, height, mini) - pad * 2
                                val geometry = DockGeometry(count)
                                val iconOnly = !dockLabelFits(expanded, item, preferred, selected, (16 * density).roundToInt())
                                geometry.update(width, expanded, item, preferred, weights, selected, iconOnly, mini)
                                assertCoverage(geometry, width)
                                if (mini == 0f && expanded >= count * item) assertTrue(geometry.widths.all { it >= item })
                                if (mini == 1f) {
                                    assertEquals(height, width + pad * 2)
                                    assertEquals(width, geometry.widths[selected])
                                    assertEquals(0, geometry.starts[selected])
                                    assertEquals(0, geometry.indicatorStart)
                                    assertEquals(width, geometry.indicatorWidth)
                                    for (rtl in listOf(false, true)) {
                                        assertEquals(height / 2f, pad + geometry.left(selected, rtl) + geometry.widths[selected] / 2f, 0f)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    @Test
    fun longLocalesAndLargeFontsFallBackWithoutReducingTouchTargets() {
        val preferred = intArrayOf(84, 108, 900, 132)
        assertTrue(dockLabelFits(276, 48, preferred, 3, 20))
        assertFalse(dockLabelFits(275, 48, preferred, 3, 20))
        assertFalse(dockLabelFits(300, 48, preferred, 2, 20))
        assertFalse(dockLabelFits(300, 48, preferred, 0, 60))
        assertTrue(dockLabelFits(1100, 48, preferred, 2, 20))
    }

    @Test
    fun interruptedSpringsAndMiniWidthStayBounded() {
        assertEquals(56, dockWidth(393, 68, 56, 1f))
        assertEquals(56, dockWidth(393, 68, 56, 1.2f))
        assertEquals(325, dockWidth(393, 68, 56, -0.2f))
        assertEquals(40, dockWidth(40, 68, 56, 1f))
        val geometry = DockGeometry(4)
        for (weights in listOf(floatArrayOf(1.1f, -0.1f, 0f, 0.2f), FloatArray(4))) {
            geometry.update(301, 301, 48, intArrayOf(84, 100, 116, 132), weights, 3, false, 0f)
            assertCoverage(geometry, 301)
        }
        assertEquals(geometry.starts[3], geometry.indicatorStart)
        assertEquals(geometry.widths[3], geometry.indicatorWidth)
    }
}
