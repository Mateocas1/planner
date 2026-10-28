import { useMemo } from "react";
import type { BlockView, TaskView } from "../../data/store.ts";
import { weeklyNumbers, type ReviewTask, type ReviewBlock, type WeeklyNumbers } from "../../planning/weekly.ts";
import { t } from "../../i18n/index.ts";
import { reviewSentences, topTaskLines } from "./weeklyFlow.ts";

/**
 * The Review step (S3): the week's few numbers, in sentences rather than a
 * dashboard. The arithmetic is `planning/weekly.ts`'s (W2a); this pane only
 * prints it, through the shared wording in `weeklyFlow.ts`.
 *
 * The tracked total is a cumulative counter over the tasks completed this
 * week, so until r2-w2c's per-day history lands the number is a record of
 * completed work, not of every minute: `weeklyNumbers` documents the limit,
 * and when the API grows `actualIsPartial` this pane marks the line
 * "approximate" — quietly, no warning dress.
 */
export function ReviewStep({
  tasks,
  blocks,
  timeZone,
  now,
}: {
  tasks: readonly TaskView[];
  blocks: readonly BlockView[];
  timeZone: string;
  now: Date;
}) {
  const numbers = useMemo(
    () => weeklyNumbers({ now, timeZone, tasks: tasks as readonly ReviewTask[], blocks: blocks as readonly ReviewBlock[] }),
    [tasks, blocks, timeZone, now],
  );
  // The field arrives with r2-w2c; reading it defensively keeps this pane
  // honest today and exact tomorrow without touching `planning/weekly.ts`.
  const partial = (numbers as WeeklyNumbers & { actualIsPartial?: boolean }).actualIsPartial === true;
  const lines = reviewSentences(numbers, partial);
  const top = topTaskLines(numbers.topTasks);

  return (
    <div className="weekly-pane-body">
      <dl className="weekly-numbers">
        {lines.map(line => (
          <div key={line.label} className="weekly-number">
            <dt>{line.label}</dt>
            <dd>{line.value}</dd>
          </div>
        ))}
      </dl>
      <section className="weekly-top" aria-labelledby="weekly-top-heading">
        <h4 id="weekly-top-heading" className="weekly-subtitle">{t("weekly.topHeading")}</h4>
        {top.length === 0 ? (
          <p className="weekly-empty">{t("weekly.topEmpty")}</p>
        ) : (
          <ul className="weekly-top-list">
            {top.map((entry, index) => (
              <li key={entry.title} className="weekly-top-row">
                <span className="weekly-top-rank" aria-hidden="true">{index + 1}</span>
                <span className="weekly-top-title" title={entry.title}>{entry.title}</span>
                <span className="weekly-top-minutes">{entry.value}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
