---
name: commit-message
summary: write a commit message for the staged changes
args: style=conventional commits
---
Run `git diff --staged` (and `git log -5 --oneline` to match the repo's habits). If nothing is staged, say so and stop.

Write a commit message in this style: {{style}}. A subject line of at most 72 characters in the imperative, a blank line, then a short body explaining why the change was made rather than restating the diff. Output only the message, in a code block. Do not run `git commit`.
