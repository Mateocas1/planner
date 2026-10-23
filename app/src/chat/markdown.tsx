/**
 * React rendering of the Markdown subset (the parser's rules are in
 * markdown.ts). Everything here renders parsed data as React elements — the
 * model's text is never injected as HTML, so it cannot carry markup.
 *
 * `StreamedAnswer` renders a partial answer in three zones: the stable prefix
 * as parsed blocks, and the trailing block still being written as a reveal
 * tail. The tail is itself inline-parsed, and the text from the first
 * unpaired `**`/`*`/`` ` `` marker is held back until the marker closes
 * (`visibleTailEnd`), so raw markers never show mid-stream; at `done` the
 * completed answer replaces the tail and any marker still unclosed renders
 * literally. What is visible of the tail renders through the inline parser —
 * bold, italic and code appear formatted as they stream — with the per-chunk
 * reveal spans inside the parsed elements: a span keeps its identity by chunk
 * index, so its blur-in runs once per chunk, and older chunks settle into
 * plain text so the DOM stays bounded on a long answer. Re-parsing the stable
 * prefix every frame changes nothing visually.
 */

import { Fragment, type ReactNode } from "react";
import { parseInline, parseInlineRanges, parseMarkdown, stableBoundary, visibleTailEnd, type MarkdownBlock, type MarkdownInline, type MarkdownInlineRange } from "./markdown.ts";

/** Chunks kept as animated spans; older ones collapse into plain text. */
const liveSpanBudget = 6;

function renderInline(inline: MarkdownInline, children: ReactNode, key: number): ReactNode {
  switch (inline.kind) {
    case "bold":
      return <strong key={key}>{children}</strong>;
    case "italic":
      return <em key={key}>{children}</em>;
    case "code":
      return <code key={key}>{children}</code>;
    case "link":
      return (
        <a key={key} href={inline.href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    default:
      return <Fragment key={key}>{children}</Fragment>;
  }
}

function renderInlines(inlines: MarkdownInline[]): ReactNode[] {
  return inlines.map((inline, index) => renderInline(inline, inline.text, index));
}

function renderBlock(block: MarkdownBlock, key: number): ReactNode {
  switch (block.type) {
    case "p":
      return <p key={key}>{renderInlines(block.inlines)}</p>;
    case "code":
      return (
        <pre key={key} data-lang={block.lang || undefined}>
          <code>{block.text}</code>
        </pre>
      );
    case "ul":
      return (
        <ul key={key}>
          {block.items.map((item, index) => (
            <li key={index}>{renderInlines(item)}</li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol key={key}>
          {block.items.map((item, index) => (
            <li key={index}>{renderInlines(item)}</li>
          ))}
        </ol>
      );
  }
}

/** A finished answer (or a stable prefix): full markdown, no reveal. */
export function Markdown({ text }: { text: string }) {
  return <>{parseMarkdown(text).map(renderBlock)}</>;
}

/**
 * Split the turn's reveal chunks at the tail boundary, so only chunks inside
 * the tail become animated spans.
 */
export function tailChunkSegments(segments: string[], boundary: number): string[] {
  const pieces: string[] = [];
  let offset = 0;
  for (const segment of segments) {
    const end = offset + segment.length;
    if (end > boundary) pieces.push(segment.slice(Math.max(0, boundary - offset)));
    offset = end;
  }
  return pieces;
}

/**
 * Render the visible tail through the inline parser, keeping the per-chunk
 * reveal: each parsed range is cut at the chunk boundaries, the settled
 * chunks (index < splitAt) merge into plain text, and each live chunk becomes
 * a `chat-reveal` span keyed by its absolute index — so a span mounts once
 * and its blur-in never restarts, inside whatever element the parser built
 * (a `<strong>` may hold several chunk spans).
 */
function renderRevealTail(visible: string, chunkStarts: number[], splitAt: number): ReactNode[] {
  return parseInlineRanges(visible).map((range, index) => {
    const pieces: ReactNode[] = [];
    for (let chunk = 0; chunk < chunkStarts.length; chunk++) {
      const start = chunkStarts[chunk];
      const end = chunk + 1 < chunkStarts.length ? chunkStarts[chunk + 1] : visible.length;
      const from = Math.max(start, range.contentStart);
      const to = Math.min(end, range.contentEnd);
      if (from >= to) continue; // marker syntax (or held text) — never rendered
      const slice = visible.slice(from, to);
      if (chunk < splitAt) pieces.push(<Fragment key={`s${chunk}`}>{slice}</Fragment>);
      else pieces.push(<span className="chat-reveal" key={`c${chunk}`}>{slice}</span>);
    }
    return renderInline(range.inline, pieces, index);
  });
}

/**
 * The streaming answer: stable prefix + reveal tail. `segments` must be the
 * turn's chunk list (text === segments.join("")). While the tail is a single
 * growing paragraph it renders as inline-parsed text with reveal spans; a
 * fence tail renders as a code block; anything else is a one-frame transient
 * rendered plainly — the next chunk moves the boundary and the normal split
 * resumes.
 */
export function StreamedAnswer({ text, segments }: { text: string; segments: string[] }) {
  const boundary = stableBoundary(text);
  const tail = text.slice(boundary);
  if (tail === "") return <Markdown text={text} />;
  const tailBlocks = parseMarkdown(tail);
  const singleParagraph = tailBlocks.length === 1 && tailBlocks[0].type === "p";

  if (!singleParagraph) {
    // Open code fence (or a transient multi-block tail): render as parsed.
    return (
      <>
        <Markdown text={text.slice(0, boundary)} />
        {tailBlocks.map(renderBlock)}
      </>
    );
  }

  // Hold back everything from the first unpaired marker; chunks past the
  // visible end stay hidden until their marker closes.
  const visible = tail.slice(0, visibleTailEnd(tail));
  if (visible === "") return <Markdown text={text.slice(0, boundary)} />;

  const chunks = tailChunkSegments(segments, boundary);
  const chunkStarts: number[] = [];
  const visibleChunks: string[] = [];
  let consumed = 0;
  for (const chunk of chunks) {
    if (consumed >= visible.length) break;
    const kept = chunk.length <= visible.length - consumed ? chunk : chunk.slice(0, visible.length - consumed);
    chunkStarts.push(consumed);
    visibleChunks.push(kept);
    consumed += kept.length;
  }
  const splitAt = Math.max(0, visibleChunks.length - liveSpanBudget);
  return (
    <>
      <Markdown text={text.slice(0, boundary)} />
      <p className="chat-reveal-p">{renderRevealTail(visible, chunkStarts, splitAt)}</p>
    </>
  );
}
