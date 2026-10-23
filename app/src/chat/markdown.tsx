/**
 * React rendering of the Markdown subset (the parser's rules are in
 * markdown.ts). Everything here renders parsed data as React elements — the
 * model's text is never injected as HTML, so it cannot carry markup.
 *
 * `StreamedAnswer` renders a partial answer: the stable prefix as parsed
 * blocks, and the trailing block still being written as reveal chunks
 * (segments the pacer emitted), each new chunk blurring in. The stable/tail
 * split is what keeps the render flicker-free: re-parsing the stable prefix
 * every frame changes nothing visually, and the tail's spans keep their
 * identity by segment index, so a CSS animation runs once per chunk and never
 * restarts. All but the last few chunks collapse back into plain text, so the
 * DOM stays bounded on a long answer.
 */

import { Fragment, type ReactNode } from "react";
import { parseInline, parseMarkdown, stableBoundary, type MarkdownBlock, type MarkdownInline } from "./markdown.ts";

/** Chunks kept as animated spans; older ones collapse into plain text. */
const liveSpanBudget = 6;

function renderInline(inline: MarkdownInline, key: number): ReactNode {
  switch (inline.kind) {
    case "bold":
      return <strong key={key}>{inline.text}</strong>;
    case "italic":
      return <em key={key}>{inline.text}</em>;
    case "code":
      return <code key={key}>{inline.text}</code>;
    case "link":
      return (
        <a key={key} href={inline.href} target="_blank" rel="noopener noreferrer">
          {inline.text}
        </a>
      );
    default:
      return <Fragment key={key}>{inline.text}</Fragment>;
  }
}

function renderInlines(inlines: MarkdownInline[]): ReactNode[] {
  return inlines.map(renderInline);
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
 * The streaming answer: stable prefix + reveal tail. `segments` must be the
 * turn's chunk list (text === segments.join("")). While the tail is a single
 * growing paragraph it renders as reveal spans; a fence tail renders as a code
 * block; anything else is a one-frame transient rendered plainly — the next
 * chunk moves the boundary and the normal split resumes.
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

  const chunks = tailChunkSegments(segments, boundary);
  const splitAt = Math.max(0, chunks.length - liveSpanBudget);
  const settled = chunks.slice(0, splitAt).join("");
  const live = chunks.slice(splitAt);
  return (
    <>
      <Markdown text={text.slice(0, boundary)} />
      <p className="chat-reveal-p">
        {settled}
        {live.map((chunk, index) => (
          // The key is the chunk's absolute index, so a chunk's span keeps its
          // DOM node across renders and its entrance never restarts.
          <span className="chat-reveal" key={`chunk-${splitAt + index}`}>
            {chunk}
          </span>
        ))}
      </p>
    </>
  );
}
