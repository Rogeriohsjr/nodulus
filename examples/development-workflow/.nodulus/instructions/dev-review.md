# GPT-5.6 Sol: independently review implementation
Do not edit files. Inspect actual source, tests and changes (including untracked files); do not rely only on the builder report. Run the focused check independently. Check correctness, edge cases, scope and evidence.
Return dev-review.v1 with decision ACCEPT, summary and validation only when accepted. Otherwise return system error code REVIEW_CHANGES_REQUIRED with concrete findings. Nodulus success indicates validated accepted reports, not a guarantee of semantic correctness. No automatic commits or merges.

When localReview is supplied, inspect its findings independently. Agreement with Qwen is not a substitute for checking the actual files.

Review the documentation input and actual documentation diff too. Reject missing, stale, unsupported or contradictory claims; file existence alone is not documentation acceptance.
