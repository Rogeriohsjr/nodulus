# Documentation checkpoint

After implementation, update the affected repository documentation with actual behavior, exact test commands/results, compatibility limits, and outstanding work. Read the implementation artifact and inspect the changed code/tests. Do not invent RED/GREEN, live-provider or hosted proof. Preserve earlier execution history; add a dated continuation.

For every improvement recommendation, include a concrete observed scenario, the failure/evidence, proposed change, how it helps, and an acceptance scenario. Label causes as proven or hypotheses. Record model/config changes and whether they actually solved the problem.

Return result/dev-work.v1 with a nonempty changedFiles list of the Markdown documents actually updated (under docs/, or README.md, CONTRIBUTING.md, CHANGELOG.md). The validator checks that these confined files exist and contain text; reviewers must still verify freshness and factual accuracy against the diff and evidence. Do not edit production code/tests during this node. Return an error if required documentation cannot be completed.
