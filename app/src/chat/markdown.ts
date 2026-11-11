/**
 * The Markdown subset: paragraphs, bold, italic, inline code,
 * fenced code blocks, ordered/unordered lists and links. Parsed to data, never
 * to HTML — the model's text reaches the DOM only as React children
 * (`ui/markdown.tsx` renders it), so nothing can inject markup.
 *
 * Built for mid-stream rendering: `parseMarkdown` on a partial answer never
 * throws and never reinterprets earlier text. An unterminated fence is a code
 * block that is still open; an unfinished line is a paragraph; a `**` without
 * its closing pair is literal text.
 */

export type MarkdownInline =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

/** A parsed inline plus where it sits in the source, so the streaming renderer
 * can split it across the pacer's chunks. `contentStart/contentEnd` bound the
 * displayed text inside the match (the `**`/`*`/`` ` ``/link syntax around it
 * is never rendered). */
export type MarkdownInlineRange = {
  inline: MarkdownInline;
  start: number;
  end: number;
  contentStart: number;
  contentEnd: number;
};

export type MarkdownBlock =
  | { type: "p"; inlines: MarkdownInline[] }
  | { type: "code"; lang: string; text: string; open: boolean }
  | { type: "ul"; items: MarkdownInline[][] }
  | { type: "ol"; items: MarkdownInline[][] };

const fencePattern = /^\s*```(.*)$/;
const bulletPattern = /^\s*[-*]\s+(.*)$/;
const orderedPattern = /^\s*\d+[.)]\s+(.*)$/;

/**
 * Where the trailing, still-growing block starts: everything before it is
 * stable (re-parsed every frame without visual change), everything after is
 * the reveal tail. Runs on raw text because the tail's own block type is not
 * decided yet — the last line may become a list item or a fence.
 *
 * Rules:
 * - inside an open fence, the tail starts at the fence's opening line (the
 *   whole fence is the tail, rendered as a code block);
 * - otherwise the tail starts after the last blank line (a fresh paragraph or
 *   list); text with no blank line yet is all tail.
 */
export function stableBoundary(text: string): number {
  let boundary = 0;
  let index = 0;
  let inFence = false;
  let fenceStart = -1;
  const lines = text.split("\n");
  for (const line of lines) {
    const fence = fencePattern.exec(line);
    if (inFence) {
      if (fence !== null) inFence = false;
    } else if (fence !== null) {
      inFence = true;
      fenceStart = index;
    } else if (line.trim() === "") {
      boundary = index + line.length + 1; // after the newline that ends this line
    }
    index += line.length + 1;
  }
  if (inFence) return fenceStart;
  return Math.min(boundary, text.length);
}

/**
 * Split inline text into styled runs. One scan, alternation-ordered so `**`
 * wins over `*`; a marker without its pair stays literal. Nesting (bold
 * inside a link label, code inside bold) is out of the subset.
 */
export function parseInlineRanges(text: string): MarkdownInlineRange[] {
  const pattern = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  const ranges: MarkdownInlineRange[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    if (start > cursor) ranges.push({ inline: { kind: "text", text: text.slice(cursor, start) }, start: cursor, end: start, contentStart: cursor, contentEnd: start });
    const [, bold, italic, code, label, href] = match;
    if (bold !== undefined) {
      ranges.push({ inline: { kind: "bold", text: bold }, start, end, contentStart: start + 2, contentEnd: end - 2 });
    } else if (italic !== undefined) {
      ranges.push({ inline: { kind: "italic", text: italic }, start, end, contentStart: start + 1, contentEnd: end - 1 });
    } else if (code !== undefined) {
      ranges.push({ inline: { kind: "code", text: code }, start, end, contentStart: start + 1, contentEnd: end - 1 });
    } else {
      ranges.push({ inline: { kind: "link", text: label ?? "", href: href ?? "" }, start, end, contentStart: start + 1, contentEnd: start + 1 + (label ?? "").length });
    }
    cursor = end;
  }
  if (cursor < text.length) ranges.push({ inline: { kind: "text", text: text.slice(cursor) }, start: cursor, end: text.length, contentStart: cursor, contentEnd: text.length });
  return ranges;
}

/** Split inline text into styled runs. One scan, alternation-ordered so `**`
 * wins over `*`; a marker without its pair stays literal. Nesting (bold
 * inside a link label, code inside bold) is out of the subset. */
export function parseInline(text: string): MarkdownInline[] {
  return parseInlineRanges(text).map(range => range.inline);
}

/**
 * How much of a still-streaming tail may be *displayed* right now (review #1):
 * the length of the longest prefix whose inline parse shows no raw marker.
 * Everything from the first marker character that no completed construct
 * (bold, italic, code span) has consumed is held back until its pair arrives,
 * so the live text never reads `You have **two bl`. A partial fence opening
 * (a final line of `` ` ``s that is not a fence yet) is covered by the same
 * rule; a complete opening fence is handled upstream, where the tail renders
 * as a code block.
 *
 * The holdback is display-only: the completed answer parses the full text, so
 * a marker still unclosed at `done` renders literally, exactly as the parser
 * treats any unmatched marker.
 */
export function visibleTailEnd(text: string): number {
  const ranges = parseInlineRanges(text);
  const firstMarker = (from: number, to: number): number => {
    if (to <= from) return -1;
    const found = text.slice(from, to).search(/\*\*|\*|`/);
    return found === -1 ? -1 : from + found;
  };
  // A text range is an unmatched run: any `*` or `` ` `` inside it has no pair.
  for (const range of ranges) {
    if (range.inline.kind !== "text") continue;
    const marker = firstMarker(range.start, range.end);
    if (marker !== -1) return marker;
  }
  const after = ranges.length > 0 ? ranges[ranges.length - 1].end : 0;
  const marker = firstMarker(after, text.length);
  return marker === -1 ? text.length : marker;
}

/** Group raw lines into blocks. Whitespace-only lines separate blocks. */
export function parseMarkdown(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = text.split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "") {
      index++;
      continue;
    }
    const fence = fencePattern.exec(line);
    if (fence !== null) {
      const lang = fence[1].trim();
      const body: string[] = [];
      index++;
      let open = true;
      while (index < lines.length) {
        if (fencePattern.test(lines[index])) {
          open = false;
          index++;
          break;
        }
        body.push(lines[index]);
        index++;
      }
      blocks.push({ type: "code", lang, text: body.join("\n"), open });
      continue;
    }
    const bullets: MarkdownInline[][] = [];
    const ordered: MarkdownInline[][] = [];
    while (index < lines.length && lines[index].trim() !== "") {
      const line = lines[index];
      const bullet = bulletPattern.exec(line);
      const numbered = orderedPattern.exec(line);
      if (bullet !== null) {
        bullets.push(parseInline(bullet[1]));
      } else if (numbered !== null) {
        ordered.push(parseInline(numbered[1]));
      } else {
        // A plain line ends any list in progress and opens a paragraph.
        if (bullets.length > 0 || ordered.length > 0) break;
        // Gather the paragraph's lines (soft line breaks become spaces).
        const paragraph: string[] = [line];
        index++;
        while (index < lines.length && lines[index].trim() !== "" && !fencePattern.test(lines[index]) && !bulletPattern.test(lines[index]) && !orderedPattern.test(lines[index])) {
          paragraph.push(lines[index].trim());
          index++;
        }
        blocks.push({ type: "p", inlines: parseInline(paragraph.join(" ")) });
        continue;
      }
      index++;
    }
    if (bullets.length > 0) blocks.push({ type: "ul", items: bullets });
    else if (ordered.length > 0) blocks.push({ type: "ol", items: ordered });
  }
  return blocks;
}
