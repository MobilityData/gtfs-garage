/**
 * Where a dataset stands, as the host sees it.
 *
 * A host knows whether a dataset has been prepared and how far along it is; the
 * viewer knows how to say so. This interface is the whole of what a host
 * supplies - facts, never markup - and `mountDataset` renders every state from
 * it, so no integration writes its own progress bar or its own error box.
 */

import type { LoadProgress, ViewerSource } from "./sources/types";

export type DatasetState =
  /** Nothing has been prepared yet. `prepare` is offered the chance to start it. */
  | { state: "absent" }
  /**
   * Being prepared. `progress` uses the same phases a feed load reports -
   * download, extract, convert, summarise - so the wording is already written.
   */
  | { state: "preparing"; progress?: LoadProgress }
  /** Ready to browse. The host supplies the source, so it decides how to read it. */
  | { state: "ready"; source: ViewerSource }
  | { state: "failed"; message: string };

export interface DatasetProvider {
  /**
   * Where the dataset stands. Polled while it is being prepared, and passed an
   * `AbortSignal` that fires when the viewer goes away mid-request.
   */
  status(signal: AbortSignal): Promise<DatasetState>;

  /**
   * Start preparing the dataset, for a host that offers that. Called at most
   * once, on the first `absent` - calling it per poll would queue a conversion
   * every second.
   */
  prepare?(signal: AbortSignal): Promise<void>;
}


/**
 * What to do about a reported state.
 *
 * Separated from the mounting so it can be tested without a document, which is
 * how the rest of this package is arranged: `values.ts` decides and `table.ts`
 * draws. Every rule that matters - when to stop polling, when to ask for
 * preparation, what to say - is here.
 */
export interface DatasetDecision {
  /** What to show. Absent when the viewer itself is taking the root over. */
  line?: string;
  tone?: "error";
  /** Stop polling: there is nothing further to wait for. */
  settled?: boolean;
  /** Ask the host to begin preparing. Never more than once. */
  prepare?: boolean;
  /** Open the viewer on this. */
  source?: ViewerSource;
}

export interface DecisionContext {
  /** Named in the lines, so a host can say which dataset is meant. */
  description: string;
  /** Whether the host offers to start preparation at all. */
  canPrepare: boolean;
  /** Whether it has already been asked. */
  asked: boolean;
  /** How a progress reading is worded; the viewer's own load phrasing. */
  phrase: (progress: LoadProgress | null, description: string) => string;
}

export function decideDataset(status: DatasetState, context: DecisionContext): DatasetDecision {
  const { description, canPrepare, asked, phrase } = context;

  switch (status.state) {
    case "ready":
      return { settled: true, source: status.source };

    case "failed":
      // The host's reason, not a generic failure: "could not open the dataset"
      // tells an operator nothing they can act on.
      return { settled: true, line: status.message, tone: "error" };

    case "absent":
      if (!canPrepare) return { settled: true, line: `${description} has not been prepared yet.` };
      // Once. Asked on every poll, this would queue a conversion a second.
      return asked ? { line: `Preparing ${description}…` } : { prepare: true, line: `Preparing ${description}…` };

    case "preparing":
      return { line: phrase(status.progress ?? null, description) };
  }
}
