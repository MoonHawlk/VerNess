---
name: code-review
summary: review a file or directory for bugs, risks and clarity
persona: reviewer
args: path, focus=correctness and edge cases
---
Review the code at `{{path}}`. Read it first, then read what it calls if you need context.

Focus: {{focus}}.

Report findings ordered by severity. For each: `file:line`, what is wrong, why it matters, and a concrete fix. Skip style nitpicks a formatter would catch. If you find nothing serious, say so plainly instead of inventing issues. Do not edit any file.
