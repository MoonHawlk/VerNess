---
name: write-tests
summary: write tests for a file, following the repo's test style
persona: qa-engineer
args: path
---
Write tests for `{{path}}`.

1. Find how this repo tests things (the test runner, folder and naming) and copy that style exactly.
2. Cover the normal path, edge cases (empty, missing, malformed input) and each error branch.
3. Add the tests, run them, and fix any that fail because of the test, not the code.

If a test exposes a real bug in `{{path}}`, do not change the code: report the bug and leave the test failing with a clear name.
