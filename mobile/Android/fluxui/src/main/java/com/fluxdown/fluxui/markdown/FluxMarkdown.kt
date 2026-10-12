package com.fluxdown.fluxui.markdown

import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import com.fluxdown.fluxui.theme.FluxTheme

/** CommonMark → Compose 富文本；不执行 HTML，也不自动请求远端图片。 */
@Composable
fun FluxMarkdown(
    markdown: String,
    onOpenLink: (String) -> Unit,
    modifier: Modifier = Modifier,
    maxLines: Int = Int.MAX_VALUE,
    onTextLayout: ((TextLayoutResult) -> Unit)? = null,
) {
    val colors = FluxTheme.colors
    val type = FluxTheme.type
    val openLink = rememberUpdatedState(onOpenLink)
    val document = remember(markdown) { MarkdownText.parse(markdown) }
    val text = remember(document, colors, type) {
        MarkdownText.render(
            document,
            MarkdownStyles(
                heading = listOf(type.h1, type.h2, type.bodyM).map {
                    it.toSpanStyle().copy(color = colors.ink)
                },
                strong = SpanStyle(fontFamily = type.weight(type.sm, 600).fontFamily, fontWeight = FontWeight.SemiBold),
                emphasis = SpanStyle(fontStyle = FontStyle.Italic),
                code = type.monoS.toSpanStyle().copy(background = colors.glassSolid2),
                quote = SpanStyle(color = colors.inkMuted, fontStyle = FontStyle.Italic),
                link = SpanStyle(color = colors.accent, textDecoration = TextDecoration.Underline),
                spacerLineHeight = type.sm.fontSize * 0.2f,
            ),
        ) { openLink.value(it) }
    }
    BasicText(
        text = text,
        modifier = modifier,
        style = type.sm.copy(color = colors.inkMuted),
        maxLines = maxLines,
        overflow = TextOverflow.Ellipsis,
        onTextLayout = onTextLayout,
    )
}
