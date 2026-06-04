# Foreground tool calls appeared to return empty output

## Symptom

Eight consecutive foreground tool calls (six Bash, two Read) appeared to return empty output in real time. I retried — which is why you saw the same ls/find/pwd commands fired repeatedly — interpreting the blanks as a harness failure.

## Actual cause

The calls were not failing. Every one of them executed correctly; the results were buffered and delivered in a single batched block after a delay. The likely reason: the deep-research Workflow is running in the background, and the harness queued/flushed my foreground tool results behind it rather than streaming them back individually.

## Net effect

No data lost, no commands failed. But I burned redundant calls retrying things that had already succeeded, and the apparent "dead tools" was a false signal.

## What I actually got

 A batched return did give me what I needed.

## State / next

  - The deep-research workflow is still running in the background; I'll be notified on completion (watch
  with /workflows).
  - I have enough code context to tie the eventual roadmap to real files.