package com.fluxdown.fluxui.chrome

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationVector1D
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.graphics.drawOutline
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.Placeable
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.util.lerp
import com.fluxdown.fluxui.icons.FluxIcon
import com.fluxdown.fluxui.theme.FluxScaleGroup
import com.fluxdown.fluxui.theme.FluxText
import com.fluxdown.fluxui.theme.FluxTheme
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/** 导航坞徽标：计数或红点。 */
@Immutable
sealed interface FluxDockBadge {
    /** 计数徽标（> 99 显示 `99+`；≤ 0 不显示）。 */
    @Immutable
    data class Count(val n: Int) : FluxDockBadge

    /** 8dp 珊瑚红点。 */
    @Immutable
    data object Dot : FluxDockBadge
}

/**
 * 导航坞目的地。[badgeDescription] 会并入无障碍描述（如“3 条未读”），徽标本身不单独朗读。
 */
@Immutable
data class FluxDockItem(
    val icon: ImageVector,
    val label: String,
    val badge: FluxDockBadge? = null,
    val badgeDescription: String? = null,
)

private val DockPad = 4.dp

/**
 * 浮动导航坞：实色胶囊与细边线区分内容层，不依赖投影。
 * 选中项展开为“图标 + 文字”（accentLo 纯底 + accent 描边、accentHi 图标与文字）。
 * 各项铺满内宽，指示器沿实际项边界运动。
 *
 * 本组件在父容器内**占满宽度、固定为主题 dockHeight 高**；坞本体宽 = 容器宽 − [reservedEnd]（球位 + 间距 12）。
 * 迷你态宽高相同。由应用负责摆放，系统导航栏上方留 8dp。
 *
 * - [mini]：应用按滚动方向决定（向下 Δ>5dp 迷你，向上 / 顶部展开）；迷你态点击坞 → [onExpand]，不触发选中。
 * - [hidden]：推入页 / Expanded 隐藏（`alpha 0、translateY 30dp`，退场结束后移出组合）。
 * - [selectionMode]：多选模式，坞淡出（`translateY 18、scale .94`），由 [SelectionDock] 接替。
 * - 选中项按标签实测宽度展开，其余项均分余宽；无法保留 48dp 点击宽度时全部仅显示图标。
 * - 点击不同项触发 tick 触感；点击当前项同样回调 [onSelect]（应用可据此回顶并展开坞）。
 */
@Composable
fun FluxDock(
    items: List<FluxDockItem>,
    selected: Int,
    onSelect: (Int) -> Unit,
    modifier: Modifier = Modifier,
    mini: Boolean = false,
    onExpand: () -> Unit = {},
    hidden: Boolean = false,
    selectionMode: Boolean = false,
    reservedEnd: Dp = FluxTheme.space.dockHeight + 12.dp,
    contentDescription: String = "主导航",
    expandDescription: String = "展开导航",
) {
    if (items.isEmpty()) return
    val motion = FluxTheme.motion
    val hideP = rememberChromePresence(!hidden, motion.fluid)
    val selP = rememberChromePresence(!selectionMode, motion.liquid)
    BoxWithConstraints(
        modifier
            .fillMaxWidth()
            .height(FluxTheme.space.dockHeight),
        contentAlignment = Alignment.CenterStart,
    ) {
        if (hideP.composed && selP.composed) {
            DockBody(
                items = items,
                selected = selected.coerceIn(0, items.lastIndex),
                onSelect = onSelect,
                mini = mini,
                onExpand = onExpand,
                interactive = !hidden && !selectionMode,
                hideP = hideP,
                selP = selP,
                availPx = constraints.maxWidth,
                reservedEnd = reservedEnd,
                groupDescription = contentDescription,
                expandDescription = expandDescription,
            )
        }
    }
}

@Composable
private fun DockBody(
    items: List<FluxDockItem>,
    selected: Int,
    onSelect: (Int) -> Unit,
    mini: Boolean,
    onExpand: () -> Unit,
    interactive: Boolean,
    hideP: ChromePresence,
    selP: ChromePresence,
    availPx: Int,
    reservedEnd: Dp,
    groupDescription: String,
    expandDescription: String,
) {
    val type = FluxTheme.type
    val motion = FluxTheme.motion
    val haptics = FluxTheme.haptics
    val density = LocalDensity.current
    val dockHeight = FluxTheme.space.dockHeight
    val itemSize = dockHeight - DockPad * 2
    val itemWidthPx = with(density) { itemSize.roundToPx() }
    val n = items.size

    val labelStyle = remember(type) { type.weight(type.sm, 500).copy(letterSpacing = 0.005.em) }
    val measurer = rememberTextMeasurer()
    val labelSizes = remember(items, labelStyle, density, measurer) {
        items.map { measurer.measure(it.label, labelStyle, softWrap = false, maxLines = 1).size }
    }
    val preferredWidths = remember(labelSizes, density, itemWidthPx) {
        val contentPadding = with(density) { (20.dp + 8.dp + 24.dp).roundToPx() }
        IntArray(items.size) { (labelSizes[it].width + contentPadding).coerceAtLeast(itemWidthPx) }
    }
    val expandedWidth = with(density) {
        dockWidth(availPx, reservedEnd.roundToPx(), dockHeight.roundToPx(), 0f)
    }
    val expandedInnerWidth = (expandedWidth - with(density) { DockPad.roundToPx() } * 2).coerceAtLeast(0)
    val iconOnly = !dockLabelFits(expandedInnerWidth, itemWidthPx, preferredWidths, selected, labelSizes[selected].height)
    val miniA = remember { Animatable(if (mini) 1f else 0f) }
    val selA = remember(n) { List(n) { Animatable(if (it == selected) 1f else 0f) } }
    val geometry = remember(n) { DockGeometry(n) }
    val selectionWeights = remember(n) { FloatArray(n) }
    val placeables = remember(n) { arrayOfNulls<Placeable>(n) }
    LaunchedEffect(selected, mini, n) {
        launch { miniA.animateTo(if (mini) 1f else 0f, motion.of(motion.liquid)) }
        selA.forEachIndexed { i, a -> launch { a.animateTo(if (i == selected) 1f else 0f, motion.of(motion.liquid)) } }
    }

    val shape = FluxTheme.shapes.sheet
    Box(
        Modifier
            .layout { measurable, c ->
                val w = dockWidth(c.maxWidth, reservedEnd.roundToPx(), dockHeight.roundToPx(), miniA.value)
                val p = measurable.measure(Constraints.fixed(w, dockHeight.roundToPx()))
                layout(p.width, p.height) { p.place(0, 0) }
            }
            .chromeFade(translateY = 30.dp) { hideP.progress.value }
            .chromeFade(translateY = 18.dp, scaleFrom = 0.94f) { selP.progress.value }
            .floatingChromeSurface(shape)
            .clip(shape)
            .semantics {
                isTraversalGroup = true
                contentDescription = groupDescription
            },
    ) {
        Layout(
            content = {
                DockIndicator()
                items.forEachIndexed { i, item ->
                    DockItemView(
                        item = item,
                        isSelected = i == selected,
                        sel = selA[i],
                        mini = miniA,
                        labelStyle = labelStyle,
                        showLabel = !iconOnly && dockLabelFits(
                            expandedInnerWidth, itemWidthPx, preferredWidths, i, labelSizes[i].height,
                        ),
                        enabled = interactive && !mini,
                        onClick = {
                            if (i != selected) haptics.tick()
                            onSelect(i)
                        },
                    )
                }
            },
            modifier = Modifier.fillMaxSize(),
        ) { measurables, constraints ->
            val itemH = itemSize.roundToPx()
            val top = DockPad.roundToPx()
            for (i in items.indices) selectionWeights[i] = selA[i].value
            geometry.update(
                innerWidth = (constraints.maxWidth - top * 2).coerceAtLeast(0),
                expandedInnerWidth = expandedInnerWidth,
                minimumItemWidth = itemH,
                preferredWidths = preferredWidths,
                selection = selectionWeights,
                selected = selected,
                iconOnly = iconOnly,
                mini = miniA.value,
            )
            val indPlaceable = measurables[0].measure(
                Constraints.fixed(geometry.indicatorWidth, itemH),
            )
            for (i in items.indices) {
                placeables[i] = measurables[i + 1].measure(Constraints.fixed(geometry.widths[i], itemH))
            }
            val rtl = layoutDirection == LayoutDirection.Rtl
            layout(constraints.maxWidth, constraints.maxHeight) {
                indPlaceable.place(top + geometry.indicatorLeft(rtl), top)
                for (i in items.indices) placeables[i]?.place(top + geometry.left(i, rtl), top)
            }
        }
        if (mini) {
            Box(
                Modifier
                    .fillMaxSize()
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        enabled = interactive,
                        role = Role.Button,
                        onClick = onExpand,
                    ),
            )
        }
    }
}

/** 液态指示器：`accentLo` 纯底 + accent 发丝描边（选中态统一语义；无渐变、无辉光）。浅色描边更轻，免得像按钮外框。 */
@Composable
private fun DockIndicator() {
    val c = FluxTheme.colors
    val shape = CircleShape
    Box(
        Modifier
            .drawWithCache {
                val outline = shape.createOutline(size, layoutDirection, this)
                val line = c.accent.copy(alpha = if (c.dark) 0.30f else 0.20f)
                val hw = 0.5.dp.toPx()
                onDrawBehind {
                    drawOutline(outline, c.accentLo)
                    drawOutline(outline, line, style = Stroke(hw))
                }
            },
    )
}

@Composable
private fun DockItemView(
    item: FluxDockItem,
    isSelected: Boolean,
    sel: Animatable<Float, AnimationVector1D>,
    mini: Animatable<Float, AnimationVector1D>,
    labelStyle: TextStyle,
    showLabel: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    val c = FluxTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val description = item.badgeDescription?.let { "${item.label}，$it" } ?: item.label
    Box(
        Modifier
            .clip(CircleShape)
            .selectable(
                selected = isSelected,
                interactionSource = interaction,
                indication = null,
                enabled = enabled,
                role = Role.Tab,
                onClick = onClick,
            )
            .semantics { contentDescription = description },
        contentAlignment = Alignment.Center,
    ) {
        Row(
            Modifier
                .wrapContentWidth(align = Alignment.CenterHorizontally, unbounded = true)
                .clearAndSetSemantics { },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(20.dp)) {
                FluxIcon(
                    item.icon, null,
                    Modifier.graphicsLayer { alpha = 1f - sel.value.coerceIn(0f, 1f) },
                    tint = if (pressed) c.ink else c.inkMuted,
                )
                FluxIcon(
                    item.icon, null,
                    Modifier.graphicsLayer { alpha = sel.value.coerceIn(0f, 1f) },
                    tint = c.accentHi,
                )
            }
            if (showLabel) {
                FluxText(
                    item.label,
                    modifier = Modifier
                        .layout { m, _ ->
                            val p = m.measure(Constraints())
                            val f = (sel.value * (1f - mini.value)).coerceIn(0f, 1f)
                            val gap = 8.dp.roundToPx()
                            val w = ((p.width + gap) * f).roundToInt()
                            layout(w, p.height) { p.placeRelative((gap * f).roundToInt(), 0) }
                        }
                        .graphicsLayer { alpha = (sel.value * (1f - mini.value)).coerceIn(0f, 1f) },
                    style = labelStyle,
                    color = c.accentHi,
                    maxLines = 1,
                    overflow = TextOverflow.Clip,
                    softWrap = false,
                )
            }
        }
        val badge = item.badge
        if (badge != null && !(badge is FluxDockBadge.Count && badge.n <= 0)) {
            DockBadgeView(badge, sel, mini)
        }
    }
}

@Composable
private fun BoxScope.DockBadgeView(
    badge: FluxDockBadge,
    sel: Animatable<Float, AnimationVector1D>,
    mini: Animatable<Float, AnimationVector1D>,
) {
    val c = FluxTheme.colors
    val type = FluxTheme.type
    val position = Modifier
        .align(Alignment.TopEnd)
        .offset {
            val right = lerp(11f, 5f, sel.value.coerceIn(0f, 1f))
            val top = if (badge is FluxDockBadge.Dot) 12.dp else 9.dp
            IntOffset(-right.dp.roundToPx(), top.roundToPx())
        }
        .graphicsLayer { alpha = 1f - mini.value.coerceIn(0f, 1f) }
    when (badge) {
        is FluxDockBadge.Count -> {
            val style = remember(type) {
                type.sized(type.weight(type.monoS, 600, mono = true), 10f, FluxScaleGroup.Ks)
            }
            Box(
                position
                    .sizeIn(minWidth = 16.dp, minHeight = 16.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(c.accent)
                    .padding(horizontal = 4.dp)
                    .clearAndSetSemantics { },
                contentAlignment = Alignment.Center,
            ) {
                FluxText(
                    if (badge.n > 99) "99+" else badge.n.toString(),
                    style = style,
                    color = c.onAccent,
                    maxLines = 1,
                    softWrap = false,
                )
            }
        }
        FluxDockBadge.Dot -> Box(
            position
                .size(8.dp)
                .clip(CircleShape)
                .background(c.coral)
                .clearAndSetSemantics { },
        )
    }
}
