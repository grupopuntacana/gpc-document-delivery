---
allowed-tools: Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git push:*), Bash(gh pr:*)
description: Create a pull request
---

Create a pull request

Follow these steps:

1. Check `git status` for uncommitted changes - warn if any exist before proceeding
2. Gather information using `git diff master...HEAD` and `git log master..HEAD` to understand all changes relative to the base branch
3. Use this information to write a clear, meaningful PR description that explains the purpose and impact of the changes
4. Push and create a PR

Remember to use the GitHub CLI (`gh`) for all GitHub-related tasks.
