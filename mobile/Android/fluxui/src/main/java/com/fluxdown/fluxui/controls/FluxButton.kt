package com.fluxdown.fluxui.controls

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.selected
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
import com.fluxdown.fluxui.material.fluxAccentSurface
import com.fluxdown.fluxui.material.fluxGlow
import com.fluxdown.fluxui.theme.FluxText
import com.fluxdown.fluxui.theme.FluxTheme
import com.fluxdown.fluxui.theme.fluxPressable

/** 按钮变体（§12.23）：主 / 次 / 幽灵 / 危险（危险没有实心红底，只有 coral 字与描边）。 */
enum class ButtonVariant { Primary, Secondary, Ghost, Danger }

/** 按钮尺寸：高 / 圆角 / 水平内边距 / 图标 / 主按钮投影高度。`Sm`、`Xs` 视觉不足 48dp，命中区自动补足。 */
enum class ButtonSize(
    internal val height: Dp,
    internal val radius: Dp,
    internal val hPad: Dp,
    internal val icon: Dp,
    internal val spinner: Dp,
    internal val lift: Dp,
) {
    Default(48.dp, 24.dp, 22.dp, 20.dp, 22.dp, 6.dp),
    Sm(36.dp, 18.dp, 16.dp, 20.dp, 18.dp, 4.dp),
    Xs(30.dp, 15.dp, 12.dp, 16.dp, 16.dp, 3.dp),
}

/**
 * 按钮。按压 `scale .97`（`press` 弹簧），禁用 α .38，主按钮为强调色实心面（[fluxAccentSurface]，带向下投影）。
 * 高度只设下限（200% 字体时标签可折 2 行）；[loading] 时标签隐藏（保持宽度）并显示旋转环，点击被忽略。
 */
@Composable
fun FluxButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    variant: ButtonVariant = ButtonVariant.Secondary,
    size: ButtonSize = ButtonSize.Default,
    icon: ImageVector? = null,
    trailingIcon: ImageVector? = null,
    fullWidth: Boolean = false,
    enabled: Boolean = true,
    loading: Boolean = false,
) {
    val c = FluxTheme.colors
    val t = FluxTheme.type
    val shape = remember(size) { RoundedCornerShape(size.radius) }
    val radiusPx = with(androidx.compose.ui.platform.LocalDensity.current) { size.radius.toPx() }
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    val labelColor = when (variant) {
        ButtonVariant.Primary -> c.onAccent
        ButtonVariant.Secondary, ButtonVariant.Ghost -> c.ink
        ButtonVariant.Danger -> c.coralText
    }
    val textStyle = remember(t, size) {
        (if (size == ButtonSize.Default) t.weight(t.body, 600).copy(letterSpacing = (-0.005f).em) else t.weight(t.sm, 600))
            .copy(textAlign = TextAlign.Center)
    }

    Box(
        modifier
            .then(if (fullWidth) Modifier.fillMaxWidth() else Modifier)
            .alpha(if (enabled) 1f else 0.38f)
            .fluxFocusRing(shape, visualHeight = size.height)
            .fluxPressable(onClick = onClick, enabled = enabled && !loading, role = Role.Button, interactionSource = source)
            .semantics { if (loading) stateDescription = "加载中" }
            .sizeIn(minHeight = 48.dp),
        contentAlignment = Alignment.Center,
    ) {
        val surface = when (variant) {
            ButtonVariant.Primary -> Modifier.fluxAccentSurface(c, shape, lift = size.lift)
            ButtonVariant.Secondary -> Modifier
                .fluxGlass(FluxGlass.G3, shape, kind = FluxGlassKind.Flat, strongLine = true)
            ButtonVariant.Danger -> Modifier
                .fluxGlass(FluxGlass.G3, shape, kind = FluxGlassKind.Flat, strongLine = false)
                .border(0.5.dp, c.coral.copy(alpha = 0.36f), shape)
            ButtonVariant.Ghost -> Modifier.drawBehind {
                if (pressed) drawRoundRect(c.glass2, cornerRadius = CornerRadius(radiusPx))
            }
        }
        Box(
            Modifier
                .then(if (fullWidth) Modifier.fillMaxWidth() else Modifier)
                .heightIn(min = size.height)
                .then(surface),
            contentAlignment = Alignment.Center,
        ) {
            Row(
                Modifier
                    .padding(horizontal = size.hPad)
                    .alpha(if (loading) 0f else 1f),
                horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (icon != null) FluxIcon(icon, null, Modifier.horizontalOverlap(1.dp), size.icon, labelColor)
                FluxText(text, style = textStyle, color = labelColor, maxLines = 2, modifier = Modifier.weight(1f, fill = false))
                if (trailingIcon != null) FluxIcon(trailingIcon, null, Modifier.horizontalOverlap(1.dp), 18.dp, labelColor)
            }
            if (loading) InlineSpinner(size.spinner, labelColor)
        }
    }
}

/** 图标按钮尺寸：圆直径 / 图标。命中区一律补足 48dp。 */
enum class IconButtonSize(internal val dp: Dp, internal val icon: Dp) {
    Sm(36.dp, 18.dp), Md(40.dp, 20.dp), Lg(48.dp, 20.dp)
}

/**
 * 圆形图标按钮（按压 `scale .92`）。[glass] = `glass2` 底，false = 透明；[selected] = “on”（accentHi 图标 + accentLo 底 + accent@40% 描边）；
 * [badge] 右上角 7dp 发光点；[danger] 图标 coral。[contentDescription] 必填（无障碍名称）。
 */
@Composable
fun FluxIconButton(
    icon: ImageVector,
    contentDescription: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    size: IconButtonSize = IconButtonSize.Md,
    glass: Boolean = true,
    selected: Boolean = false,
    badge: Boolean = false,
    danger: Boolean = false,
    enabled: Boolean = true,
) {
    val c = FluxTheme.colors
    val tint = when {
        selected -> c.accentHi
        danger -> c.coralText
        else -> c.ink
    }
    val bg = when {
        selected -> c.accentLo
        glass -> c.glass2
        else -> Color.Transparent
    }
    Box(
        modifier
            .alpha(if (enabled) 1f else 0.38f)
            .fluxFocusRing(CircleShape, visualWidth = size.dp, visualHeight = size.dp)
            .fluxPressable(onClick = onClick, scale = 0.92f, enabled = enabled, role = Role.Button)
            .semantics {
                this.contentDescription = contentDescription
                if (selected) this.selected = true
            }
            .sizeIn(minWidth = 48.dp, minHeight = 48.dp),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .size(size.dp)
                .background(bg, CircleShape)
                .then(if (selected) Modifier.border(0.5.dp, c.accent.copy(alpha = 0.4f), CircleShape) else Modifier),
            contentAlignment = Alignment.Center,
        ) {
            FluxIcon(icon, null, size = size.icon, tint = tint)
            if (badge) {
                val inset = size.dp * 0.23f
                Box(
                    Modifier
                        .align(Alignment.TopEnd)
                        .padding(top = inset, end = inset)
                        .size(7.dp)
                        .fluxGlow(c.accentHi, 4.dp, CircleShape)
                        .background(c.accentHi, CircleShape),
                )
            }
        }
    }
}

/** 分裂按钮菜单项的无障碍等价动作（TalkBack 自定义动作）。 */
@Immutable
data class SplitMenuAction(val label: String, val onClick: () -> Unit)

/**
 * 分裂按钮（§12.24）：主区执行默认动作，箭头区请求菜单。两区独立按压（叠 `onAccent` α .12 状态层），
 * 两区之间是上下内缩的 1dp `onAccent` 细分隔线。
 * 本组件不依赖浮层：点箭头区回调 [onMenuClick]，参数为箭头区在根坐标系的包围盒，由应用以它作锚点弹出菜单。
 * [menuActions] 仅用于 TalkBack 自定义动作（视觉菜单由应用负责）。
 */
@Composable
fun FluxSplitButton(
    label: String,
    onClick: () -> Unit,
    onMenuClick: (anchorInRoot: Rect) -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    enabled: Boolean = true,
    menuLabel: String = "更多选项",
    menuActions: List<SplitMenuAction> = emptyList(),
) {
    val c = FluxTheme.colors
    val t = FluxTheme.type
    val shape = remember { RoundedCornerShape(26.dp) }
    val mainSource = remember { MutableInteractionSource() }
    val arrowSource = remember { MutableInteractionSource() }
    val mainPressed by mainSource.collectIsPressedAsState()
    val arrowPressed by arrowSource.collectIsPressedAsState()
    val arrowCoords = remember { arrayOfNulls<LayoutCoordinates>(1) }
    val textStyle = remember(t) { t.weight(t.body, 600) }

    Row(
        modifier
            .alpha(if (enabled) 1f else 0.38f)
            .fluxFocusRing(shape)
            .fluxAccentSurface(c, shape, lift = 6.dp)
            .clip(shape)
            .heightIn(min = 52.dp)
            .height(IntrinsicSize.Min),
    ) {
        Box(
            Modifier
                .weight(1f)
                .fillMaxHeight()
                .clickable(interactionSource = mainSource, indication = null, enabled = enabled, role = Role.Button, onClick = onClick)
                .drawBehind { if (mainPressed) drawRect(c.onAccent.copy(alpha = 0.12f)) }
                .padding(start = 24.dp, end = 20.dp),
            contentAlignment = Alignment.Center,
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                if (icon != null) FluxIcon(icon, null, size = 20.dp, tint = c.onAccent)
                FluxText(label, style = textStyle, color = c.onAccent, maxLines = 2, modifier = Modifier.weight(1f, fill = false))
            }
        }
        Box(
            Modifier
                .width(52.dp)
                .fillMaxHeight()
                .onGloballyPositioned { arrowCoords[0] = it }
                .clickable(interactionSource = arrowSource, indication = null, enabled = enabled, role = Role.Button) {
                    arrowCoords[0]?.boundsInRoot()?.let(onMenuClick)
                }
                .drawBehind {
                    if (arrowPressed) drawRect(c.onAccent.copy(alpha = 0.12f))
                    val inset = 14.dp.toPx()
                    drawRect(
                        c.onAccent.copy(alpha = 0.28f),
                        topLeft = Offset(0f, inset),
                        size = Size(1.dp.toPx(), (size.height - 2 * inset).coerceAtLeast(0f)),
                    )
                }
                .semantics {
                    contentDescription = menuLabel
                    stateDescription = "折叠"
                    if (menuActions.isNotEmpty()) {
                        customActions = menuActions.map { a -> CustomAccessibilityAction(a.label) { a.onClick(); true } }
                    }
                },
            contentAlignment = Alignment.Center,
        ) {
            FluxIcon(FluxIcons.ChevronDown, null, size = 20.dp, tint = c.onAccent)
        }
    }
}
