# Bounded feedback routing example

This local example prepares caller text, normalizes it, asks a review node to accept or return `FIX_TEXT`, and writes the accepted text to a report artifact. The feedback region is `normalize` through `review`; `prepare` runs once before the region and `report` runs only after acceptance. A correction re-enters at `normalize`.

The example uses a controlled local child-process fixture. It does not contact a model provider. The fixture intentionally returns the original text as its first candidate unless that text is already canonical. The review checks NFC normalization, trimmed edges, and collapsed whitespace, including a single tab or line break. The second candidate applies those rules. Empty and whitespace-only source text are valid; the latter normalizes to empty text.

After building the package, run the default sample:

```sh
node examples/feedback-routing/run.mjs
```

Pass `--text "text to normalize"` to choose caller text. Pass `--project ./sample-project` to save the run in a new or empty project directory; the runner refuses any nonempty project, including a partial `.nodulus` tree, before copying example files. `--max-provider-calls 3` demonstrates a bounded failure: the correction would need a fourth region call, so no report node runs. The maximum iteration count is 2 and the elapsed-time limit is 30 seconds.

The exported `runFeedbackExample({ projectRoot, text, maxProviderCalls })` helper drives the same runnable flow and is used by the scenario test. A generated project is retained so its report and run records remain available. The static `.nodulus` tree has no generated run data and no machine-specific executable path; the runner sets the captured local profile to the current `process.execPath`.
