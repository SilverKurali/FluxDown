package com.fluxdown.fluxui.overlay

import androidx.compose.animation.core.animate
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.absoluteOffset
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.AbsoluteAlignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import com.fluxdown.fluxui.icons.FluxIcon
import com.fluxdown.fluxui.material.fluxAccentSurface
import com.fluxdown.fluxui.theme.FluxText
import com.fluxdown.fluxui.theme.FluxTheme
import com.fluxdown.fluxui.theme.fluxPressable
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.min
import kotlin.math.roundToInt

/** 动作盘语气：Accent（强调色实心面）· Danger（coral）· Warn（amber）· Neutral（glass3）。 */
enum class FluxSwipeTone { Neutral, Accent, Danger, Warn }

/** 滑出动作盘：纯图标宽 56、带标签宽 68、r12；[showLabel] 只控制可见标签，[label] 始终保留给无障碍操作。 */
@Immutable
class FluxSwipeAction(
    val label: String,
    val icon: ImageVector,
    val tone: FluxSwipeTone = FluxSwipeTone.Neutral,
    val showLabel: Boolean = true,
    val onClick: () -> Unit,
)

/**
 * 同一作用域内只允许一行展开：任一行开始滑动 / 展开时，其余行自动收回。
 * 滚动时收起：把 [nestedScrollConnection] 挂到列表容器（`Modifier.nestedScroll(coordinator.nestedScrollConnection)`）。
 */
@Stable
class SwipeRevealCoordinator {
    internal var openToken by mutableStateOf<Any?>(null)

    /** 收起所有已展开的行。 */
    fun closeAll() {
        if (openToken != null) openToken = null
    }

    val nestedScrollConnection: NestedScrollConnection = object : NestedScrollConnection {
        override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
            closeAll()
            return Offset.Zero
        }
    }
}

@Composable
fun rememberSwipeRevealCoordinator(): SwipeRevealCoordinator = remember { SwipeRevealCoordinator() }

/** 列表 / 屏幕提供一次，其下所有 [SwipeReveal] 自动互斥；未提供时每行独立（不互斥）。 */
val LocalSwipeRevealCoordinator = compositionLocalOf<SwipeRevealCoordinator?> { null }

private const val ACTION_ICON_W = 56
private const val ACTION_LABEL_W = 68
private const val ACTION_GAP = 6
private const val ACTION_PAD = 6

internal fun swipeActionWidth(showLabel: Boolean): Int = if (showLabel) ACTION_LABEL_W else ACTION_ICON_W

/** 与 Row 一样逐项取整到像素，避免分数密度下先累加 dp 再取整导致按钮欠露。 */
internal fun Density.swipeActionRevealWidth(actionCount: Int, labeledCount: Int): Int =
    if (actionCount == 0) 0
    else (actionCount - labeledCount) * swipeActionWidth(false).dp.roundToPx() +
        labeledCount * swipeActionWidth(true).dp.roundToPx() +
        (actionCount - 1) * ACTION_GAP.dp.roundToPx() + 2 * ACTION_PAD.dp.roundToPx()

/**
 * 滑动露出动作（§12.30）。向右滑露出 [startActions]，向左滑露出 [endActions]。
 *
 * - 判定：|dx|>10dp 且 |dx|>1.4|dy| 才接管；|dy|>12dp 先发生则放弃（让给滚动）。触感 gestureStart。
 * - 最大露出 = 各动作宽度 + 相邻间距 + 两侧内边距；越界阻尼 ×0.25；无该侧动作 ×0.18。
 * - 松手：|x|>56dp → 展开（tick），否则回弹（fluid）；|x| > 最大露出+70dp → 直接执行该侧首个动作（confirm）。
 * - 展开后点击行内容 = 收起（不触发内容点击）。
 * - 无障碍：全部动作暴露为 customActions；动作盘本身不进入无障碍树。
 *
 * @param onFullSwipe 全幅滑过时回调（参数为该侧首个动作）；null 时直接调用该动作的 onClick
 */
@Composable
fun SwipeReveal(
    modifier: Modifier = Modifier,
    startActions: List<FluxSwipeAction> = emptyList(),
    endActions: List<FluxSwipeAction> = emptyList(),
    enabled: Boolean = true,
    onFullSwipe: ((FluxSwipeAction) -> Unit)? = null,
    coordinator: SwipeRevealCoordinator = LocalSwipeRevealCoordinator.current ?: rememberSwipeRevealCoordinator(),
    content: @Composable () -> Unit,
) {
    val haptics = FluxTheme.haptics
    val motion = FluxTheme.motion
    val scope = rememberCoroutineScope()
    val token = remember { Any() }
    val offset = remember { mutableFloatStateOf(0f) }
    val isOpen = remember { mutableStateOf(false) }
    val job = remember { arrayOfNulls<Job>(1) }
    val start by rememberUpdatedState(startActions)
    val end by rememberUpdatedState(endActions)
    val motionNow by rememberUpdatedState(motion)
    val fullSwipe by rememberUpdatedState(onFullSwipe)
    val density = LocalDensity.current
    val startReveal by rememberUpdatedState(with(density) {
        swipeActionRevealWidth(startActions.size, startActions.count { it.showLabel }).toFloat()
    })
    val endReveal by rememberUpdatedState(with(density) {
        swipeActionRevealWidth(endActions.size, endActions.count { it.showLabel }).toFloat()
    })

    fun settleTo(target: Float) {
        job[0]?.cancel()
        job[0] = scope.launch {
            animate(offset.floatValue, target, animationSpec = motionNow.of(motionNow.fluid)) { v, _ -> offset.floatValue = v }
            isOpen.value = target != 0f
        }
    }

    // 其他行展开 / 滚动收起 → 本行收回
    LaunchedEffect(coordinator) {
        snapshotFlow { coordinator.openToken }.collect { open ->
            if (open !== token && offset.floatValue != 0f) settleTo(0f)
        }
    }
    DisposableEffect(coordinator) {
        onDispose { if (coordinator.openToken === token) coordinator.openToken = null }
    }
    LaunchedEffect(enabled) {
        if (!enabled && offset.floatValue != 0f) settleTo(0f)
    }

    val gesture = if (enabled) {
        Modifier.pointerInput(Unit) {
            val slopX = 10.dp.toPx()
            val slopY = 12.dp.toPx()
            val holdPx = 56.dp.toPx()
            val fullExtraPx = 70.dp.toPx()
            fun resist(raw: Float): Float {
                val maxL = startReveal
                val maxR = endReveal
                return when {
                    raw > 0f -> when {
                        start.isEmpty() -> raw * 0.18f
                        raw > maxL -> maxL + (raw - maxL) * 0.25f
                        else -> raw
                    }
                    raw < 0f -> when {
                        end.isEmpty() -> raw * 0.18f
                        -raw > maxR -> -(maxR + (-raw - maxR) * 0.25f)
                        else -> raw
                    }
                    else -> 0f
                }
            }

            awaitEachGesture {
                val down = awaitFirstDown(requireUnconsumed = false)
                val base = offset.floatValue
                var dx = 0f
                var dy = 0f
                var dragging = false
                while (true) {
                    val event = awaitPointerEvent()
                    val change = event.changes.firstOrNull { it.id == down.id } ?: break
                    if (change.isConsumed && !dragging) break
                    if (!change.pressed) break
                    val d = change.positionChange()
                    dx += d.x
                    dy += d.y
                    if (!dragging) {
                        if (abs(dx) > slopX && abs(dx) > abs(dy) * 1.4f) {
                            dragging = true
                            job[0]?.cancel()
                            isOpen.value = false
                            haptics.gestureStart()
                            coordinator.openToken = token
                        } else if (abs(dy) > slopY) {
                            break
                        } else {
                            continue
                        }
                    }
                    change.consume()
                    offset.floatValue = resist(base + dx)
                }
                if (!dragging) return@awaitEachGesture

                val x = offset.floatValue
                val side = if (x > 0f) start else end
                val n = side.size
                val full = if (x > 0f) startReveal else endReveal
                when {
                    n > 0 && abs(x) > full + fullExtraPx -> {
                        haptics.confirm()
                        val first = side.first()
                        settleTo(0f)
                        fullSwipe?.invoke(first) ?: first.onClick()
                    }
                    n > 0 && abs(x) > holdPx -> {
                        haptics.tick()
                        coordinator.openToken = token
                        settleTo(if (x > 0f) full else -full)
                    }
                    else -> settleTo(0f)
                }
            }
        }
    } else {
        Modifier
    }

    val tones = rememberSwipeTones()
    val type = FluxTheme.type
    val hasLabels = startActions.any { it.showLabel } || endActions.any { it.showLabel }
    // 为最多两行缩放标签、20dp 图标和间距留足高度；无标签操作的命中高度仍至少 48dp。
    val actionMinHeight = if (hasLabels) {
        with(density) { type.micro.fontSize.toDp() * 2.6f } + 36.dp
    } else {
        60.dp
    }

    Box(
        modifier
            .fillMaxWidth()
            .heightIn(min = if (enabled && (startActions.isNotEmpty() || endActions.isNotEmpty())) actionMinHeight else 0.dp)
            .clipToBounds()
            .then(gesture)
            .semantics {
                if (enabled) {
                    customActions = (startActions + endActions).map { a ->
                        CustomAccessibilityAction(a.label) { a.onClick(); true }
                    }
                }
            },
    ) {
        val revealed by remember { derivedStateOf { offset.floatValue != 0f } }
        if (enabled && revealed) {
            UnderActions(
                offset = { offset.floatValue },
                start = startActions,
                end = endActions,
                tones = tones,
                onAction = { a ->
                    settleTo(0f)
                    a.onClick()
                },
            )
        }
        Box(Modifier.absoluteOffset { IntOffset(offset.floatValue.roundToInt(), 0) }.clipToBounds()) {
            content()
            if (isOpen.value) {
                Box(
                    Modifier
                        .matchParentSize()
                        .pointerInput(Unit) { detectTapGestures { settleTo(0f) } },
                )
            }
        }
    }
}

/** 裁切操作盘的绘制和命中区域，只露出前景行实际让出的空间。 */
internal class SwipeActionRevealShape(private val offset: Float) : Shape {
    override fun createOutline(size: Size, layoutDirection: LayoutDirection, density: Density): Outline {
        val left = if (offset < 0f) (size.width + offset).coerceAtLeast(0f) else 0f
        val right = if (offset > 0f) offset.coerceAtMost(size.width) else if (offset < 0f) size.width else 0f
        return Outline.Rectangle(Rect(left, 0f, right, size.height))
    }
}

/** [accent] = 强调色实心面（[fluxAccentSurface]，忽略 [bg] / [border]）。 */
@Immutable
private class SwipeToneStyle(val bg: Color, val border: Color, val fg: Color, val accent: Boolean = false)

@Composable
private fun rememberSwipeTones(): Map<FluxSwipeTone, SwipeToneStyle> {
    val c = FluxTheme.colors
    return remember(c) {
        mapOf(
            FluxSwipeTone.Neutral to SwipeToneStyle(c.glass3, c.hairlineStrong, c.ink),
            FluxSwipeTone.Accent to SwipeToneStyle(c.accentFill, Color.Transparent, c.onAccent, accent = true),
            FluxSwipeTone.Danger to SwipeToneStyle(
                c.coral.copy(alpha = 0.22f).compositeOver(c.glass2),
                c.coral.copy(alpha = 0.40f), c.coralText,
            ),
            FluxSwipeTone.Warn to SwipeToneStyle(
                c.amber.copy(alpha = 0.20f).compositeOver(c.glass2),
                c.amber.copy(alpha = 0.36f), c.amberText,
            ),
        )
    }
}

@Composable
private fun BoxScope.UnderActions(
    offset: () -> Float,
    start: List<FluxSwipeAction>,
    end: List<FluxSwipeAction>,
    tones: Map<FluxSwipeTone, SwipeToneStyle>,
    onAction: (FluxSwipeAction) -> Unit,
) {
    val leading by remember { derivedStateOf { offset() > 0f } }
    // 两侧不能在同一个 Row 中分摊宽度：窄行会挤压末尾按钮。只布局当前侧，
    // 另一侧既不参与测量，也不留下透明但仍可点击的操作盘。
    Box(
        Modifier
            .matchParentSize()
            .graphicsLayer {
                // 与前景的整数像素位移共用边界，避免拖动或回弹中透叠。
                shape = SwipeActionRevealShape(offset().roundToInt().toFloat())
                clip = true
            }
            .clearAndSetSemantics { },
        contentAlignment = if (leading) AbsoluteAlignment.CenterLeft else AbsoluteAlignment.CenterRight,
    ) {
        ActionSide(if (leading) start else end, leading, offset, tones, onAction)
    }
}

@Composable
private fun ActionSide(
    actions: List<FluxSwipeAction>,
    leading: Boolean,
    offset: () -> Float,
    tones: Map<FluxSwipeTone, SwipeToneStyle>,
    onAction: (FluxSwipeAction) -> Unit,
) {
    if (actions.isEmpty()) return
    val c = FluxTheme.colors
    val type = FluxTheme.type
    val shape = remember { RoundedCornerShape(12.dp) }
    val labelStyle = remember(type) {
        type.weight(type.micro, 500).copy(letterSpacing = 0.02.em, textAlign = TextAlign.Center)
    }
    Row(
        Modifier
            .fillMaxHeight()
            .padding(horizontal = ACTION_PAD.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(ACTION_GAP.dp),
    ) {
        actions.forEach { a ->
            val tone = tones.getValue(a.tone)
            Column(
                Modifier
                    .width(swipeActionWidth(a.showLabel).dp)
                    .fillMaxHeight()
                    .graphicsLayer {
                        val x = offset()
                        val visible = if (leading) x > 0f else x < 0f
                        val rv = if (visible) min(1f, abs(x) / swipeActionWidth(a.showLabel).dp.toPx()) else 0f
                        alpha = rv
                        val s = 0.6f + 0.4f * rv
                        scaleX = s
                        scaleY = s
                    }
                    .then(
                        if (tone.accent) {
                            Modifier.fluxAccentSurface(c, shape, lift = 0.dp)
                        } else {
                            Modifier.background(tone.bg, shape).border(0.5.dp, tone.border, shape)
                        },
                    )
                    .fluxPressable({ onAction(a) }, role = Role.Button)
                    .padding(horizontal = 4.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(4.dp, Alignment.CenterVertically),
            ) {
                FluxIcon(a.icon, null, size = 20.dp, tint = tone.fg)
                if (a.showLabel) FluxText(a.label, style = labelStyle, color = tone.fg, maxLines = 2)
            }
        }
    }
}
