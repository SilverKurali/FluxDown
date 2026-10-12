package com.fluxdown.fluxui.markdown

import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MarkdownTextTest {
    private val heading = SpanStyle(fontSize = 1.4.em, fontWeight = FontWeight.Bold)
    private val styles = MarkdownStyles(
        heading = listOf(heading, heading, heading),
        strong = SpanStyle(fontWeight = FontWeight.SemiBold),
        emphasis = SpanStyle(fontStyle = FontStyle.Italic),
        code = SpanStyle(fontFamily = FontFamily.Monospace),
        quote = SpanStyle(fontStyle = FontStyle.Italic),
        link = SpanStyle(),
        spacerLineHeight = 2.6.sp,
    )

    private fun render(source: String, onOpenLink: (String) -> Unit = {}): AnnotatedString =
        MarkdownText.render(MarkdownText.parse(source), styles, onOpenLink)

    @Test
    fun releaseNotesHaveStyledHeadingsAndHangingListItems() {
        val text = render("## 0.5.5 - 2026-10-09\n\n### 新功能\n- 新增 **BitTorrent** 总开关\n- 支持 `Android` 更新")
        assertEquals("0.5.5 - 2026-10-09\n\n新功能\n\n• 新增 BitTorrent 总开关\n• 支持 Android 更新", text.text)
        assertTrue(text.spanStyles.any { it.item == heading && text.text.substring(it.start, it.end) == "新功能" })
        assertTrue(text.spanStyles.any { it.item.fontWeight == FontWeight.SemiBold && text.text.substring(it.start, it.end) == "BitTorrent" })
        val item = text.paragraphStyles.first { text.text.substring(it.start, it.end).startsWith("•") }
        assertEquals(0.em, item.item.textIndent?.firstLine)
        assertEquals(1.5.em, item.item.textIndent?.restLine)
    }

    @Test
    fun nestedListsKeepNumberingAndContinuationIndent() {
        val text = render("3. First\n   - Nested\n\n   Second paragraph\n4. Last")
        assertEquals("3. First\n\n• Nested\n\nSecond paragraph\n\n4. Last", text.text)
        val nested = text.paragraphStyles.first { text.text.substring(it.start, it.end) == "• Nested" }
        assertEquals(1.5.em, nested.item.textIndent?.firstLine)
        assertEquals(3.em, nested.item.textIndent?.restLine)
        val continuation = text.paragraphStyles.first { text.text.substring(it.start, it.end) == "Second paragraph" }
        assertEquals(1.5.em, continuation.item.textIndent?.firstLine)
    }

    @Test
    fun emphasisNestsAndEscapedSyntaxStaysLiteral() {
        val text = render("**bold *italic*** and \\*literal\\* &amp; `**code**`")
        assertEquals("bold italic and *literal* & **code**", text.text)
        assertTrue(text.spanStyles.any { it.item.fontWeight == FontWeight.SemiBold && text.text.substring(it.start, it.end) == "bold italic" })
        assertTrue(text.spanStyles.any { it.item.fontStyle == FontStyle.Italic && text.text.substring(it.start, it.end) == "italic" })
        assertTrue(text.spanStyles.any { it.item.fontFamily == FontFamily.Monospace && text.text.substring(it.start, it.end) == "**code**" })
    }

    @Test
    fun codeBlocksPreserveWhitespaceAndDoNotInterpretSyntax() {
        val text = render("```kotlin\n  **literal**\n    <tag>\n```\n\n    indented code")
        assertEquals("  **literal**\n    <tag>\n\nindented code", text.text)
        assertFalse(text.spanStyles.any { it.item.fontWeight == FontWeight.SemiBold })
        assertTrue(text.spanStyles.filter { it.item.fontFamily == FontFamily.Monospace }
            .map { text.text.substring(it.start, it.end) } == listOf("  **literal**\n    <tag>", "indented code"))
    }

    @Test
    fun quotesAndLineBreaksRemainStructured() {
        val text = render("> quoted\n> continuation  \n> next\n\n---\n\nFinal")
        assertEquals("quoted continuation\nnext\n\n────────\n\nFinal", text.text)
        assertEquals(1.em, text.paragraphStyles.first().item.textIndent?.firstLine)
        assertTrue(text.spanStyles.any { it.item.fontStyle == FontStyle.Italic && text.text.substring(it.start, it.end) == "quoted continuation\nnext" })
    }

    @Test
    fun blockSeparatorsUseCompactMetricsInsteadOfFullBodyLines() {
        val text = render("### Heading\n\n- Tight one\n- Tight two\n\nParagraph\n\n1. Loose one\n\n2. Loose two")
        val separators = Regex("\n+").findAll(text.text).toList()
        assertFalse(separators.isEmpty())
        assertEquals(setOf(1, 2), separators.map { it.value.length }.toSet())
        for (separator in separators) {
            val start = separator.range.first
            val end = separator.range.last + 1
            val paragraph = text.paragraphStyles.single { it.start == start && it.end == end }
            val span = text.spanStyles.single { it.start == start && it.end == end }
            // Both metrics must be compact: shrinking only the font leaves inherited line
            // height in place, and shrinking only line height leaves body-sized font metrics.
            assertEquals(styles.spacerLineHeight, paragraph.item.lineHeight)
            assertEquals(styles.spacerLineHeight, span.item.fontSize)
        }
    }

    @Test
    fun referenceLinksDispatchOnlySafeDestinations() {
        val opened = mutableListOf<String>()
        val text = render("[官网][site] [bad](javascript:alert) [local](file:///tmp/a)\n\n[site]: https://fluxdown.zerx.dev", opened::add)
        assertEquals("官网 bad local", text.text)
        val links = text.getLinkAnnotations(0, text.length)
        assertEquals(1, links.size)
        assertEquals("官网", text.text.substring(links.single().start, links.single().end))
        val link = links.single().item as LinkAnnotation.Clickable
        link.linkInteractionListener?.onClick(link)
        assertEquals(listOf("https://fluxdown.zerx.dev"), opened)
    }

    @Test
    fun commentsAreHiddenAndHtmlIsInertWhileImagesKeepAltText() {
        val text = render("<!-- release marker -->\n\nText <!-- hidden -->![logo](https://example.com/logo.png)\n\n<script>alert(1)</script>")
        assertEquals("Text logo\n\n<script>alert(1)</script>", text.text)
        val image = text.getLinkAnnotations(0, text.length).single()
        assertEquals("logo", text.text.substring(image.start, image.end))
    }
}
