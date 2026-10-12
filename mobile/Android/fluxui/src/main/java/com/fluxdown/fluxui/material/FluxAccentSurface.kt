package com.fluxdown.fluxui.material

import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.drawOutline
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.fluxdown.fluxui.theme.FluxColors

/**
 * 强调色实心面：主按钮、分裂按钮、对话框主按钮、侧栏“新建”、滑动强调动作共用的实现（§5.5）。
 *
 * 扁平纯色，无渐变、无高光层、无辉光。自下而上：
 * 1. [lift] > 0 时同色系环境投影：向下偏移且内缩，只落在形状下方，不向四周晕成光斑；
 * 2. 1dp 贴地唇边（无模糊）；
 * 3. `accentFill` 纯色填充；
 * 4. 0.5dp 定边描边：浅色压暗（在浅底上边缘清晰），深色提亮。
 *
 * `onAccent` 对 `accentFill` ≥ 4.5:1 的护栏见 [com.fluxdown.fluxui.theme.resolveAccent]。
 * 按压反馈由调用方负责（缩放或叠 `onAccent` 状态层）。
 */
internal fun Modifier.fluxAccentSurface(colors: FluxColors, shape: Shape, lift: Dp = 0.dp): Modifier {
    val surface = Modifier.drawWithCache {
        val outline = shape.createOutline(size, layoutDirection, this)
        val dark = colors.dark
        val shade = lerp(colors.accentFill, Color.Black, 0.35f)
        val lip = if (dark) Color.Black.copy(alpha = 0.35f) else shade.copy(alpha = 0.22f)
        val edge = if (dark) Color.White.copy(alpha = 0.14f) else shade.copy(alpha = 0.38f)
        val hairline = Stroke(0.5.dp.toPx())
        val lipDy = 1.dp.toPx()
        onDrawBehind {
            translate(top = lipDy) { drawOutline(outline, lip) }
            drawOutline(outline, colors.accentFill)
            drawOutline(outline, edge, style = hairline)
        }
    }
    val shadowed = if (lift > 0.dp) {
        fluxGlow(colors.accentAmbient(), lift * 0.9f, shape, spread = lift * -0.5f, dy = lift * 0.8f)
    } else {
        this
    }
    return shadowed.then(surface)
}

/** 环境投影色：浅色 = 压暗的强调色低 α（有色阴影而非光晕），深色 = 强调色低 α（保留克制的有色投影）。 */
private fun FluxColors.accentAmbient(): Color =
    if (dark) accentFill.copy(alpha = 0.30f) else lerp(accentFill, Color.Black, 0.2f).copy(alpha = 0.30f)
