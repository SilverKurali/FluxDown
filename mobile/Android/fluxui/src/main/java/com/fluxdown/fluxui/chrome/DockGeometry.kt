package com.fluxdown.fluxui.chrome

import kotlin.math.roundToInt

internal fun dockWidth(available: Int, reservedEnd: Int, height: Int, mini: Float): Int {
    val collapsed = height.coerceAtMost(available)
    val expanded = (available - reservedEnd).coerceIn(collapsed, available)
    val progress = mini.coerceIn(0f, 1f)
    return (expanded * (1.0 - progress) + collapsed * progress).roundToInt()
}

internal fun dockLabelFits(innerWidth: Int, itemSize: Int, preferredWidths: IntArray, index: Int, labelHeight: Int): Boolean =
    labelHeight <= itemSize && preferredWidths[index] <= innerWidth - itemSize * (preferredWidths.size - 1)

/** Pixel bounds shared by tab placement and the indicator; all coordinates are inner-dock relative. */
internal class DockGeometry(itemCount: Int) {
    val starts = IntArray(itemCount)
    val widths = IntArray(itemCount)
    var indicatorStart = 0
        private set
    var indicatorWidth = 0
        private set
    private var innerWidth = 0

    fun left(index: Int, rtl: Boolean): Int =
        if (rtl) innerWidth - starts[index] - widths[index] else starts[index]

    fun indicatorLeft(rtl: Boolean): Int =
        if (rtl) innerWidth - indicatorStart - indicatorWidth else indicatorStart

    fun update(
        innerWidth: Int,
        expandedInnerWidth: Int,
        minimumItemWidth: Int,
        preferredWidths: IntArray,
        selection: FloatArray,
        selected: Int,
        iconOnly: Boolean,
        mini: Float,
    ) {
        this.innerWidth = innerWidth
        val count = widths.size
        val collapse = mini.coerceIn(0f, 1f).toDouble()
        var weightSum = 0.0
        for (value in selection) weightSum += value.coerceIn(0f, 1f)
        val interpolatedWidth = expandedInnerWidth * (1.0 - collapse) + minimumItemWidth * collapse
        var cumulative = 0.0
        var cursor = 0
        for (i in 0 until count) {
            var expanded = 0.0
            for (j in 0 until count) {
                val weight = if (weightSum > 0.0) selection[j].coerceIn(0f, 1f) / weightSum
                    else if (j == selected) 1.0 else 0.0
                val selectedWidth = if (iconOnly || count == 1) expandedInnerWidth.toDouble() / count
                    else preferredWidths[j].coerceIn(
                        minimumItemWidth.coerceAtMost(expandedInnerWidth / count),
                        (expandedInnerWidth - minimumItemWidth * (count - 1)).coerceAtLeast(expandedInnerWidth / count),
                    ).toDouble()
                val width = if (i == j || count == 1) selectedWidth
                    else (expandedInnerWidth - selectedWidth) / (count - 1)
                expanded += width * weight
            }
            val collapsed = if (i == selected) minimumItemWidth.toDouble() else 0.0
            val width = expanded * (1.0 - collapse) + collapsed * collapse
            cumulative += if (interpolatedWidth > 0.0) width * innerWidth / interpolatedWidth else 0.0
            // Round cumulative edges rather than each width: even fractional densities leave no tail pixel.
            val end = if (i == count - 1) innerWidth else cumulative.roundToInt().coerceIn(cursor, innerWidth)
            starts[i] = cursor
            widths[i] = end - cursor
            cursor = end
        }
        var indicatorLeft = 0.0
        var indicatorRight = 0.0
        for (i in 0 until count) {
            val selectionWeight = if (weightSum > 0.0) selection[i].coerceIn(0f, 1f) / weightSum
                else if (i == selected) 1.0 else 0.0
            val weight = selectionWeight * (1.0 - collapse) + if (i == selected) collapse else 0.0
            indicatorLeft += starts[i] * weight
            indicatorRight += (starts[i] + widths[i]) * weight
        }
        indicatorStart = indicatorLeft.roundToInt().coerceIn(0, innerWidth)
        indicatorWidth = indicatorRight.roundToInt().coerceIn(indicatorStart, innerWidth) - indicatorStart
    }
}
