package com.fluxdown.fluxui.overlay

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.fluxdown.fluxui.icons.FluxIcon
import com.fluxdown.fluxui.icons.FluxIcons
import com.fluxdown.fluxui.material.FluxGlass
import com.fluxdown.fluxui.material.FluxGlassKind
import com.fluxdown.fluxui.material.LocalFluxBackdrop
import com.fluxdown.fluxui.material.fluxGlass
import com.fluxdown.fluxui.theme.FluxText
import com.fluxdown.fluxui.theme.FluxTheme

/**
 * 命令搜索全屏壳（§12.31，z74）：实色画布底（不透出下层页面）；入场 scale 1.02→1、模糊 10→0（fluid），出场 snap。
 * 顶部为搜索框（高至少 48dp、圆角胶囊、聚焦时 accent@70% 描边）与“取消”；其下 [content] 占满剩余空间并随键盘收缩
 * （结果列表用 LazyColumn，contentPadding = 0 16 40 自行设置）。显示后自动聚焦并弹出键盘。
 * 返回键 = [onDismiss]。
 *
 * @param onSearch 键盘“搜索”键
 * @param content 结果槽：分区 / Tab 由调用方组合（可用 [CommandSearchSectionHeader]、[rememberFluxHighlight]）
 */
@Composable
fun CommandSearchScaffold(
    visible: Boolean,
    query: String,
    onQueryChange: (String) -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String = "搜索任务、功能与设置",
    onSearch: () -> Unit = {},
    content: @Composable ColumnScope.() -> Unit,
) {
    val motion = FluxTheme.motion
    val prog = rememberOverlayProgress()
    val focusRequester = remember { FocusRequester() }
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current

    LaunchedEffect(visible) {
        if (visible) prog.enter(motion.of(motion.fluid)) else prog.exit(motion.of(motion.snap))
    }
    BackHandler(enabled = visible && prog.present, onBack = onDismiss)

    if (!prog.present) return

    LaunchedEffect(visible) {
        if (visible) {
            androidx.compose.runtime.withFrameNanos { }
            focusRequester.requestFocus()
            keyboard?.show()
        } else {
            keyboard?.hide()
            focusManager.clearFocus()
        }
    }

    // 全屏实色壳：内部玻璃面（结果分区等）不得采样下层页面的模糊副本，一律退化为合成到画布的实色。
    CompositionLocalProvider(LocalFluxBackdrop provides null) {
        Column(
            modifier
                .fillMaxSize()
                .graphicsLayer {
                    val v = prog.value
                    alpha = v.coerceIn(0f, 1f)
                    val s = 1.02f - 0.02f * v
                    scaleX = s
                    scaleY = s
                }
                .background(FluxTheme.colors.canvas)
                .swallowTaps()
                .windowInsetsPadding(WindowInsets.statusBars)
                .windowInsetsPadding(WindowInsets.ime),
        ) {
            Row(
                Modifier.fillMaxWidth().padding(start = 16.dp, top = 8.dp, end = 8.dp, bottom = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                SearchField(
                    query = query,
                    onQueryChange = onQueryChange,
                    placeholder = placeholder,
                    onSearch = onSearch,
                    focusRequester = focusRequester,
                    modifier = Modifier.weight(1f),
                )
                OverlayTextButton("取消", onDismiss)
            }
            Column(Modifier.weight(1f).fillMaxWidth()) { content() }
        }
    }
}

@Composable
private fun SearchField(
    query: String,
    onQueryChange: (String) -> Unit,
    placeholder: String,
    onSearch: () -> Unit,
    focusRequester: FocusRequester,
    modifier: Modifier,
) {
    val c = FluxTheme.colors
    val type = FluxTheme.type
    val shape = FluxTheme.shapes.full
    var focused by remember { mutableStateOf(false) }
    val textStyle: TextStyle = remember(type, c) { type.body.copy(color = c.ink) }

    Row(
        modifier
            .heightIn(min = 48.dp)
            // Real + 壳内 backdrop = null ⇒ 不透明 glassSolid3；聚焦只加 accent 描边
            .fluxGlass(FluxGlass.G3, shape, kind = FluxGlassKind.Real, strongLine = true)
            .then(if (focused) Modifier.border(1.dp, c.accent.copy(alpha = 0.7f), shape) else Modifier)
            .padding(start = 14.dp, end = if (query.isEmpty()) 14.dp else 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        FluxIcon(FluxIcons.Search, null, size = 18.dp, tint = c.inkMuted)
        Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
            if (query.isEmpty()) {
                FluxText(placeholder, style = type.body, color = c.inkFaint, maxLines = 1)
            }
            BasicTextField(
                value = query,
                onValueChange = onQueryChange,
                modifier = Modifier
                    .fillMaxWidth()
                    .focusRequester(focusRequester)
                    .onFocusChanged { focused = it.isFocused },
                textStyle = textStyle,
                singleLine = true,
                cursorBrush = SolidColor(c.accentHi),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { onSearch() }),
            )
        }
        if (query.isNotEmpty()) {
            OverlayIconButton(
                FluxIcons.X,
                "清除",
                { onQueryChange("") },
                visualSize = 28.dp,
                iconSize = 18.dp,
                glass = false,
            )
        }
    }
}

/** 分区头（micro inkMuted，padding 16/6/8，heading 语义）；[trailing] 如“共 3 项”。 */
@Composable
fun CommandSearchSectionHeader(title: String, modifier: Modifier = Modifier, trailing: String? = null) {
    val c = FluxTheme.colors
    val type = FluxTheme.type
    Row(
        modifier
            .fillMaxWidth()
            .padding(start = 6.dp, top = 16.dp, end = 6.dp, bottom = 8.dp)
            .semantics { heading() },
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        FluxText(title, style = type.micro, color = c.inkMuted, maxLines = 1)
        trailing?.let { FluxText(it, style = type.micro, color = c.inkMuted, maxLines = 1) }
    }
}

/**
 * 命中高亮：把 [text] 中所有（不区分大小写）出现的 [query] 以 accentHi + 700 字重标出。
 * [base] 为文本原样式（字重由字体族决定，所以高亮用 `type.weight(base, 700)`）。
 */
@Composable
fun rememberFluxHighlight(text: String, query: String, base: TextStyle = FluxTheme.type.body): AnnotatedString {
    val type = FluxTheme.type
    val hi = FluxTheme.colors.accentHi
    return remember(text, query, type, hi, base) {
        if (query.isBlank()) {
            AnnotatedString(text)
        } else {
            val span = type.weight(base, 700).toSpanStyle().copy(color = hi)
            buildAnnotatedString {
                var from = 0
                while (true) {
                    val i = text.indexOf(query, from, ignoreCase = true)
                    if (i < 0) break
                    append(text.substring(from, i))
                    withStyle(SpanStyle().merge(span)) { append(text.substring(i, i + query.length)) }
                    from = i + query.length
                }
                append(text.substring(from))
            }
        }
    }
}
