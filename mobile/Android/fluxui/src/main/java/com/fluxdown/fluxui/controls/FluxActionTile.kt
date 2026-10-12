package com.fluxdown.fluxui.controls

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.fluxdown.fluxui.icons.FluxIcon
import com.fluxdown.fluxui.material.FluxGlass
import com.fluxdown.fluxui.material.FluxGlassKind
import com.fluxdown.fluxui.material.fluxAccentSurface
import com.fluxdown.fluxui.material.fluxGlass
import com.fluxdown.fluxui.theme.FluxScaleGroup
import com.fluxdown.fluxui.theme.FluxText
import com.fluxdown.fluxui.theme.FluxTheme
import com.fluxdown.fluxui.theme.fluxPressable

/**
 * 动作块（页首快捷动作，对齐 iOS 地图 / 通讯录卡片的“图标在上、短标签在下”等宽动作块）。
 *
 * 一行放 3–4 个时用 `Modifier.weight(1f)`；同行等高请给父 Row `height(IntrinsicSize.Min)`、块 `fillMaxHeight()`。
 * 图标在上让每块只需容纳一个短词，窄屏 / 大字号下也不会出现“图标 + 两行文字”挤在胶囊里的折行。
 *
 * - [prominent]：强调色实心面（主动作，一行至多一个），其余为与次按钮同材质的平面玻璃 + 强发丝线。
 * - 视觉高 ≥ 56dp、r12；按压 `scale .96`；禁用 α .38；强调色面不投影。
 * - 标签最多 2 行（仅 200% 字体时出现），居中；[contentDescription] 可给出比标签更完整的无障碍名称。
 */
@Composable
fun FluxActionTile(
    label: String,
    icon: ImageVector,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    prominent: Boolean = false,
    enabled: Boolean = true,
    contentDescription: String = label,
) {
    val c = FluxTheme.colors
    val t = FluxTheme.type
    val shape = remember { RoundedCornerShape(12.dp) }
    val fg = if (prominent) c.onAccent else c.ink
    val labelStyle = remember(t) {
        t.sized(t.weight(t.sm, 500), 12f, FluxScaleGroup.Ks).copy(textAlign = TextAlign.Center)
    }
    val surface = if (prominent) {
        Modifier.fluxAccentSurface(c, shape, lift = 0.dp)
    } else {
        Modifier.fluxGlass(FluxGlass.G3, shape, kind = FluxGlassKind.Flat, strongLine = true)
    }
    Column(
        modifier
            .alpha(if (enabled) 1f else 0.38f)
            .fluxFocusRing(shape)
            .fluxPressable(onClick = onClick, scale = 0.96f, enabled = enabled, role = Role.Button)
            .semantics { this.contentDescription = contentDescription }
            .heightIn(min = 56.dp)
            .then(surface)
            .padding(horizontal = 6.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        FluxIcon(icon, null, size = 20.dp, tint = fg)
        FluxText(
            label,
            modifier = Modifier.clearAndSetSemantics { },
            style = labelStyle,
            color = fg,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
