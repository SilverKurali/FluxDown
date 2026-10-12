package com.fluxdown.fluxui.chrome

import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import com.fluxdown.fluxui.icons.FluxIcon
import com.fluxdown.fluxui.icons.FluxIcons
import com.fluxdown.fluxui.material.FluxGlass
import com.fluxdown.fluxui.material.FluxGlassKind
import com.fluxdown.fluxui.material.fluxGlass
import com.fluxdown.fluxui.material.fluxGlow
import com.fluxdown.fluxui.theme.FluxText
import com.fluxdown.fluxui.theme.FluxTheme
import com.fluxdown.fluxui.theme.fluxPressable
import kotlin.math.max

/** 推入页头左侧按钮：返回（‹）/ 关闭（✕）/ 无（详情栏内）。 */
enum class PageLead { Back, Close, None }

/**
 * 页头玻璃圆钮（`.ibtn.glass`）：Flat 玻璃 G2，按压 `scale .92`。
 * [on] = accentLo 底 + accentHi 图标 + accent 40% 描边；[dot] = 右上 7dp 提示点。
 * 视觉圆面默认 40dp，独立命中区至少 48dp。
 */
@Composable
fun FluxGlassIconButton(
    icon: ImageVector,
    contentDescription: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    on: Boolean = false,
    size: Dp = 40.dp,
    iconSize: Dp = if (size <= 36.dp) 18.dp else 20.dp,
    dot: Boolean = false,
    enabled: Boolean = true,
    onDescription: String = "已开启",
) {
    val c = FluxTheme.colors
    Box(
        modifier
            .sizeIn(minWidth = 48.dp, minHeight = 48.dp)
            .fluxPressable(onClick = onClick, scale = 0.92f, enabled = enabled, role = Role.Button)
            .semantics {
                this.contentDescription = contentDescription
                if (on) stateDescription = onDescription
            },
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .size(size)
                .then(
                    if (on) {
                        Modifier
                            .background(c.accentLo, CircleShape)
                            .border(0.5.dp, c.accent.copy(alpha = if (c.dark) 0.40f else 0.24f), CircleShape)
                    } else {
                        Modifier.fluxGlass(FluxGlass.G2, CircleShape, kind = FluxGlassKind.Flat)
                    },
                ),
            contentAlignment = Alignment.Center,
        ) {
            FluxIcon(icon, null, size = iconSize, tint = if (on) c.accentHi else c.ink)
            if (dot) {
                Box(
                    Modifier
                        .align(Alignment.TopEnd)
                        .offset(x = (-8).dp, y = 8.dp)
                        .size(7.dp)
                        .fluxGlow(c.accentHi, 4.dp, CircleShape)
                        .background(c.accentHi, CircleShape),
                )
            }
        }
    }
}

/**
 * 主机胶囊（`.hostpill`）：高 30、Flat 玻璃 G2；7dp 圆点（在线 = mint + 辉光 / 离线 = inkFaint）+ 名称 `sm 500` + ⌄。
 * a11y 描述默认“切换主机：{name}”。
 */
@Composable
fun FluxHostPill(
    name: String,
    online: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    description: String = "切换主机：$name",
) {
    val c = FluxTheme.colors
    val type = FluxTheme.type
    val nameStyle = remember(type) { type.weight(type.sm, 500) }
    Row(
        modifier
            .height(30.dp)
            .fluxPressable(onClick = onClick, role = Role.Button)
            .fluxGlass(FluxGlass.G2, CircleShape, kind = FluxGlassKind.Flat)
            .padding(start = 10.dp, end = 12.dp)
            .semantics { contentDescription = description },
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(7.dp)
                .then(if (online) Modifier.fluxGlow(c.mint, 4.dp, CircleShape) else Modifier)
                .background(if (online) c.mint else c.inkFaint, CircleShape),
        )
        FluxText(
            name,
            modifier = Modifier.weight(1f, fill = false).clearAndSetSemantics { },
            style = nameStyle,
            color = c.ink,
            maxLines = 1,
        )
        FluxIcon(FluxIcons.ChevronDown, null, size = 14.dp, tint = c.inkMuted)
    }
}

/**
 * 大标题页头（Tab 根页，`.hdr`）：`title 34` 标题 + 右侧操作槽（建议放 [FluxGlassIconButton]，间距 10）。
 * [subtitle] 为 `sm inkMuted` 副标题；[hostPill] 槽（通常是 [FluxHostPill]）位于标题下 4dp。
 * [small] = 紧凑头（标题 `h1`，垂直居中，无水平内边距）。标题 `heading()`，副标题并入同一语义节点。
 */
@Composable
fun FluxHeader(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    hostPill: (@Composable () -> Unit)? = null,
    small: Boolean = false,
    actions: @Composable RowScope.() -> Unit = {},
) {
    val c = FluxTheme.colors
    val type = FluxTheme.type
    val titleStyle = remember(type, small) {
        if (small) type.h1.copy(lineHeight = 1.2.em, letterSpacing = (-0.01).em) else type.title
    }
    Row(
        modifier
            .fillMaxWidth()
            .then(
                if (small) Modifier.padding(top = 8.dp, bottom = 10.dp)
                else Modifier.padding(horizontal = 4.dp, vertical = 14.dp),
            ),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = if (small) Alignment.CenterVertically else Alignment.Top,
    ) {
        Column(Modifier.weight(1f)) {
            Column(Modifier.semantics(mergeDescendants = true) { heading() }) {
                FluxText(title, style = titleStyle, color = c.ink, maxLines = 2)
                if (subtitle != null) {
                    FluxText(
                        subtitle,
                        modifier = Modifier.padding(top = 4.dp),
                        style = type.sm,
                        color = c.inkMuted,
                        maxLines = 2,
                    )
                }
            }
            if (hostPill != null) {
                Box(Modifier.padding(top = 4.dp)) { hostPill() }
            }
        }
        Row(
            Modifier.padding(top = if (small) 0.dp else 2.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically,
            content = actions,
        )
    }
}

/**
 * 推入页头（`.pagehead`）：左 [lead] 钮（40dp 玻璃 ‹ / ✕，48dp 命中区）、居中 `h2 600` 标题（[leftAligned] 时靠左）、
 * 可选 micro 副标题、右操作槽。两侧占位等宽以保证标题真居中。
 *
 * 应满宽放置（水平内边距取 `screenMargin`），吸顶由调用方负责；[scrolled] = 内容已滚动超过 6dp 时，
 * 背后出现 canvas 纯色底（自头部上方 46dp 起，覆盖状态栏区）并在底沿画 0.5dp 发丝线。
 */
@Composable
fun FluxPageHead(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    lead: PageLead = PageLead.Back,
    onLead: () -> Unit = {},
    scrolled: Boolean = false,
    leftAligned: Boolean = false,
    backDescription: String = "返回",
    closeDescription: String = "关闭",
    actions: @Composable RowScope.() -> Unit = {},
) {
    val c = FluxTheme.colors
    val type = FluxTheme.type
    val motion = FluxTheme.motion
    val margin = FluxTheme.space.screenMargin
    val fade = remember { Animatable(if (scrolled) 1f else 0f) }
    LaunchedEffect(scrolled, motion) { fade.animateTo(if (scrolled) 1f else 0f, motion.of(motion.fluid)) }
    val titleStyle = remember(type, leftAligned) {
        type.h2.copy(textAlign = if (leftAligned) TextAlign.Start else TextAlign.Center)
    }
    val subStyle = remember(type, leftAligned) {
        type.micro.copy(
            letterSpacing = 0.04.em,
            textAlign = if (leftAligned) TextAlign.Start else TextAlign.Center,
        )
    }

    Layout(
        content = {
            Box(Modifier.defaultMinSize(minWidth = if (lead == PageLead.None) 0.dp else 48.dp)) {
                when (lead) {
                    PageLead.Back -> FluxGlassIconButton(FluxIcons.ChevronLeft, backDescription, onLead)
                    PageLead.Close -> FluxGlassIconButton(FluxIcons.X, closeDescription, onLead)
                    PageLead.None -> Unit
                }
            }
            Column(
                Modifier.semantics(mergeDescendants = true) { heading() },
                horizontalAlignment = if (leftAligned) Alignment.Start else Alignment.CenterHorizontally,
            ) {
                FluxText(title, style = titleStyle, color = c.ink, maxLines = 1)
                if (subtitle != null) {
                    FluxText(subtitle, style = subStyle, color = c.inkMuted, maxLines = 1)
                }
            }
            Row(
                Modifier.defaultMinSize(minWidth = 48.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp, Alignment.End),
                verticalAlignment = Alignment.CenterVertically,
                content = actions,
            )
        },
        modifier = modifier
            .fillMaxWidth()
            .drawWithCache {
                val top = -46.dp.toPx()
                val hw = 0.5.dp.toPx()
                onDrawBehind {
                    val a = fade.value.coerceIn(0f, 1f)
                    if (a > 0.001f) {
                        drawRect(c.canvas, topLeft = Offset(0f, top), size = androidx.compose.ui.geometry.Size(size.width, size.height - top), alpha = a)
                        drawLine(c.hairline, Offset(0f, size.height - hw / 2f), Offset(size.width, size.height - hw / 2f), strokeWidth = hw, alpha = a)
                    }
                }
            }
            .padding(start = margin, end = margin, top = 6.dp, bottom = 10.dp),
    ) { measurables, constraints ->
        val gap = 12.dp.roundToPx()
        val loose = constraints.copy(minWidth = 0, minHeight = 0)
        val leadP = measurables[0].measure(loose)
        val actP = measurables[2].measure(loose)
        val total = constraints.maxWidth
        val titleMax = if (leftAligned) {
            total - leadP.width - actP.width - 2 * gap
        } else {
            total - 2 * max(leadP.width, actP.width) - 2 * gap
        }.coerceAtLeast(0)
        val titleP = measurables[1].measure(Constraints(maxWidth = titleMax))
        val h = max(max(leadP.height, actP.height), max(titleP.height, 48.dp.roundToPx()))
        layout(total, h) {
            leadP.place(0, (h - leadP.height) / 2)
            actP.place(total - actP.width, (h - actP.height) / 2)
            val tx = if (leftAligned) {
                leadP.width + if (leadP.width > 0) gap else 0
            } else {
                (total - titleP.width) / 2
            }
            titleP.place(tx, (h - titleP.height) / 2)
        }
    }
}
