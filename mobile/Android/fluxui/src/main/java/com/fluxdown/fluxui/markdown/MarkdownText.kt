package com.fluxdown.fluxui.markdown

import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.ParagraphStyle
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.text.style.TextIndent
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.em
import org.commonmark.node.BlockQuote
import org.commonmark.node.BulletList
import org.commonmark.node.Code
import org.commonmark.node.Document
import org.commonmark.node.Emphasis
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.HardLineBreak
import org.commonmark.node.Heading
import org.commonmark.node.HtmlBlock
import org.commonmark.node.HtmlInline
import org.commonmark.node.Image
import org.commonmark.node.IndentedCodeBlock
import org.commonmark.node.Link
import org.commonmark.node.LinkReferenceDefinition
import org.commonmark.node.ListBlock
import org.commonmark.node.Node
import org.commonmark.node.OrderedList
import org.commonmark.node.Paragraph
import org.commonmark.node.SoftLineBreak
import org.commonmark.node.StrongEmphasis
import org.commonmark.node.Text
import org.commonmark.node.ThematicBreak
import org.commonmark.parser.Parser

internal data class MarkdownStyles(
    val heading: List<SpanStyle>,
    val strong: SpanStyle,
    val emphasis: SpanStyle,
    val code: SpanStyle,
    val quote: SpanStyle,
    val link: SpanStyle,
    val spacerLineHeight: TextUnit,
)

internal object MarkdownText {
    private val parser = Parser.builder().build()

    fun parse(markdown: String): Node = parser.parse(markdown)

    fun render(document: Node, styles: MarkdownStyles, onOpenLink: (String) -> Unit): AnnotatedString =
        Renderer(styles, onOpenLink).render(document)
}

private class Renderer(private val styles: MarkdownStyles, private val onOpenLink: (String) -> Unit) {
    private val out = AnnotatedString.Builder()

    fun render(document: Node): AnnotatedString {
        block(document)
        return out.toAnnotatedString()
    }

    private fun children(node: Node, visit: (Node) -> Unit) {
        var child = node.firstChild
        while (child != null) {
            visit(child)
            child = child.next
        }
    }

    private fun blocks(node: Node, indent: Float, prefix: String, gap: Int) {
        var first = true
        children(node) {
            if (it !is LinkReferenceDefinition && !isComment(it)) {
                block(it, indent, if (first) prefix else "", if (first) gap else 2)
                first = false
            }
        }
    }

    private fun block(node: Node, indent: Float = 0f, prefix: String = "", gap: Int = 2) {
        when (node) {
            is Document -> blocks(node, indent, prefix, gap)
            is Heading -> paragraph(indent, prefix, gap) {
                out.withStyle(styles.heading[(node.level - 1).coerceAtMost(styles.heading.lastIndex)]) { inlineChildren(node) }
            }
            is Paragraph -> paragraph(indent, prefix, gap) { inlineChildren(node) }
            is BulletList, is OrderedList -> list(node as ListBlock, indent, prefix, gap)
            is BlockQuote -> out.withStyle(styles.quote) { blocks(node, indent + 1f, prefix, gap) }
            is FencedCodeBlock -> code(node.literal, indent, prefix, gap)
            is IndentedCodeBlock -> code(node.literal, indent, prefix, gap)
            is ThematicBreak -> paragraph(indent, prefix, gap) { out.append("────────") }
            // HTML remains inert text; release-language markers and other comments stay invisible.
            is HtmlBlock -> if (!isComment(node)) paragraph(indent, prefix, gap) { out.append(node.literal.trimEnd('\n')) }
            is LinkReferenceDefinition -> Unit
            else -> blocks(node, indent, prefix, gap)
        }
    }

    private fun list(node: ListBlock, indent: Float, prefix: String, gap: Int) {
        // A list item can itself start with a nested list rather than a paragraph.
        if (prefix.isNotEmpty()) paragraph(indent, prefix, gap) {}
        val listIndent = indent + if (prefix.isNotEmpty()) 1.5f else 0f
        var number = (node as? OrderedList)?.markerStartNumber ?: 1
        var first = true
        children(node) { item ->
            val marker = if (node is OrderedList) "${number++}. " else "• "
            val itemGap = if (first && prefix.isEmpty()) gap else if (node.isTight) 1 else 2
            var firstBlock = true
            children(item) { child ->
                if (child !is LinkReferenceDefinition && !isComment(child)) {
                    block(
                        child,
                        listIndent + if (firstBlock) 0f else 1.5f,
                        if (firstBlock) marker else "",
                        if (firstBlock) itemGap else if (node.isTight) 1 else 2,
                    )
                    firstBlock = false
                }
            }
            if (firstBlock) paragraph(listIndent, marker, itemGap) {}
            first = false
        }
    }

    private fun paragraph(indent: Float, prefix: String, gap: Int, content: () -> Unit) {
        if (out.length > 0) {
            // ParagraphStyle ranges already create separate Compose paragraphs. Unstyled
            // newlines between them become full-height empty lines, not just separators.
            out.withStyle(
                ParagraphStyle(
                    lineHeight = styles.spacerLineHeight,
                    lineHeightStyle = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.None),
                ),
            ) {
                withStyle(SpanStyle(fontSize = styles.spacerLineHeight)) {
                    repeat(gap) { append('\n') }
                }
            }
        }
        val start = out.length
        out.append(prefix)
        content()
        if (out.length > start) {
            out.addStyle(
                ParagraphStyle(textIndent = TextIndent(indent.em, (indent + if (prefix.isEmpty()) 0f else 1.5f).em)),
                start,
                out.length,
            )
        }
    }

    private fun code(literal: String, indent: Float, prefix: String, gap: Int) = paragraph(indent, prefix, gap) {
        out.withStyle(styles.code) { append(literal.removeSuffix("\n")) }
    }

    private fun inlineChildren(node: Node) = children(node, ::inline)

    private fun inline(node: Node) {
        when (node) {
            is Text -> out.append(node.literal)
            is Code -> out.withStyle(styles.code) { append(node.literal) }
            is StrongEmphasis -> out.withStyle(styles.strong) { inlineChildren(node) }
            is Emphasis -> out.withStyle(styles.emphasis) { inlineChildren(node) }
            is SoftLineBreak -> out.append(' ')
            is HardLineBreak -> out.append('\n')
            is Link -> link(node.destination) { inlineChildren(node) }
            // Render alt text as a link instead of fetching arbitrary remote images.
            is Image -> link(node.destination) { inlineChildren(node) }
            is HtmlInline -> if (!isComment(node)) out.append(node.literal)
            else -> inlineChildren(node)
        }
    }

    private fun link(destination: String, label: () -> Unit) {
        val scheme = destination.substringBefore(':', "").lowercase()
        if (scheme !in setOf("https", "http", "mailto")) {
            label()
            return
        }
        out.withLink(LinkAnnotation.Clickable(destination, TextLinkStyles(style = styles.link)) { onOpenLink(destination) }) {
            label()
        }
    }

    private fun isComment(node: Node): Boolean {
        val literal = when (node) {
            is HtmlBlock -> node.literal
            is HtmlInline -> node.literal
            else -> return false
        }.trim()
        return literal.startsWith("<!--") && literal.endsWith("-->")
    }
}
