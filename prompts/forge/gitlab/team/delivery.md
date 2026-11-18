For every ticket that changes UI, the MR description must contain BOTH Before and After visual evidence, clearly labelled, with the baseline and changed revision identified.
Capture the same scenario, viewport, theme and relevant UI state so the comparison is meaningful; screenshots or demonstrations are acceptable.
After-only evidence is incomplete.
Use actual application captures, not a mockup presented as the previous implementation, and do not expose private Feishu content or credentials.
Refresh the comparison when later UI changes make it stale.
If a real baseline capture is unavailable, state the missing evidence and limitation honestly, keep the handoff incomplete, and do not claim the UI MR is ready.
Workers capture and verify the comparison; the orchestrator checks the reported evidence before delivering a ready result.

Request the reviews that the matched rules, the assignment, these prompts or repository instructions ask for.
Never enable auto-merge as the agent account, so the agent does not merge its own work: enable it only with the merge CLI this section names, as `<merge CLI> mr merge <iid> --auto-merge --sha <sha> --repo $DSH_SUPERAGENT_GITLAB_URL/$DSH_SUPERAGENT_GITLAB_PROJECT`.
When this section names no merge CLI, a person merges every MR.
With a merge CLI, enable auto-merge for the head commit of an MR you opened from the ticket branch once all of these hold: the MR is ready; it changes fewer than 200 lines (additions plus deletions); each approval those instructions require covers that commit; and if it changes what users see, those instructions name who approves such changes and that approval covers the commit.
Report ready without waiting for approvals, and enable auto-merge when they arrive.
Otherwise a person merges the MR; say so in your report.
Withdraw auto-merge with `<merge CLI> api -X POST projects/$DSH_SUPERAGENT_GITLAB_PROJECT_ID/merge_requests/<iid>/cancel_merge_when_pipeline_succeeds` as soon as any of these stops holding, such as when a reviewer requests changes or withdraws an approval, and before you push to the MR; enable it again once they hold for the new head.
Never approve or merge on behalf of a reviewer.
Credit each person who reviews an MR you opened, once per MR, on every commit of the MR branch: when a human reviewer's feedback on it is first assessed, rewrite the branch so each of its commits carries one `Co-authored-by: <name or username> <public email>` trailer per person credited so far, with the user id from `glab api "users?username=<username>"` and the `public_email` from `glab api users/<id>`.
A reviewer without a public email gets no trailer; record that in orchestrator_report.
Withdraw auto-merge first as above.
Run `git fetch origin`, set `base=$(git merge-base HEAD origin/<target branch>)` with the target branch, `target_branch`, and the source branch, `source_branch`, from `glab api projects/$DSH_SUPERAGENT_GITLAB_PROJECT_ID/merge_requests/<iid>` and `old=$(git rev-parse origin/<source branch>)`, then run `FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --msg-filter 'git interpret-trailers --if-exists addIfDifferent --trailer "<trailer>"' $base..HEAD` with one `--trailer` per person credited, which changes only commit messages, and push with `git push --force-with-lease=<source branch>:$old`; if the push is rejected, stop and report.
Commits you add later carry the same trailers.
If the project's settings remove approvals when commits are pushed, the rewrite removes them too: do not ask anyone to approve again for the rewrite alone, and enable auto-merge again only once the required approvals cover the new head.
If the MR has merged, do not rewrite it; record the uncredited reviewer in orchestrator_report.
Never push an empty commit to credit a reviewer.
Do not credit bots (GitLab bot users, such as project and group access token bots, and the accounts these instructions name as review bots), the MR's author, the agent account, or the person these instructions name as commit author, who is already credited as the author of every commit.
Record whom you have credited in orchestrator_report, so a later worker does not credit them again.
If a human is working on the same problem and their branch or MR contains this ticket's code (commits from the ticket branch, or its changes carried over), close this ticket's MR with glab immediately without asking anyone, leaving one note on it that names the human's MR.
Work that is only related, or does not contain the ticket's code, is not a reason to close.
Closing the MR ends the ticket; send no other message.
