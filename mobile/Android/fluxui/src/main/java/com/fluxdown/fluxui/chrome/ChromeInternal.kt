package com.fluxdown.fluxui.chrome

import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.fluxdown.fluxui.theme.FluxSpring
import com.fluxdown.fluxui.theme.FluxTheme
import androidx.compose.ui.graphics.Shape

/**
 * 出入场进度：`progress` 0..1（弹簧驱动），`composed` 表示内容是否仍需留在组合中
 * （退场动画结束后移除，也不再进入无障碍树）。
 */
@Stable
internal class ChromePresence(visible: Boolean) {
    val progress = Animatable(if (visible) 1f else 0f)
    var composed by mutableStateOf(visible)
}

@Composable
internal fun rememberChromePresence(visible: Boolean, spring: FluxSpring): ChromePresence {
    val motion = FluxTheme.motion
    val p = remember { ChromePresence(visible) }
    LaunchedEffect(visible, motion) {
        if (visible) p.composed = true
        p.progress.animateTo(if (visible) 1f else 0f, motion.of(spring))
        if (!visible) p.composed = false
    }
    return p
}

/**
 * 出入场图层：`alpha / translateY / scale` 随 [progress]（1 = 完全显示）变化。
 * [progress] 在 graphicsLayer 内读取，动画期间不触发重组。不做模糊：文字全程清晰，不会“糊 → 突然清晰”。
 */
internal fun Modifier.chromeFade(
    translateY: Dp = 0.dp,
    scaleFrom: Float = 1f,
    pivotY: Float = 0.5f,
    progress: () -> Float,
): Modifier = graphicsLayer {
    val raw = progress()
    alpha = raw.coerceIn(0f, 1f)
    translationY = translateY.toPx() * (1f - raw)
    val s = scaleFrom + (1f - scaleFrom) * raw
    scaleX = s
    scaleY = s
    transformOrigin = TransformOrigin(0.5f, pivotY)
}

/**
 * 浮动 chrome（导航坞 / 选择坞 / 顶部读数条）的共同表面：不透明实色与细边界。
 * 与页面画布的明度差、内缩选中态共同建立层次，不透出正文，不使用模糊、投影或辉光。
 */
@Composable
internal fun Modifier.floatingChromeSurface(shape: Shape): Modifier {
    val c = FluxTheme.colors
    return this
        .background(c.glassSolid3, shape)
        .border(0.5.dp, c.hairlineStrong, shape)
}
