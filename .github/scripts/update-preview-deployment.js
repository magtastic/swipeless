// Rewrite the "## Preview Deployment" section of the PR body in place.
// Called from .github/workflows/pr.yml via actions/github-script.
module.exports = async ({ github, context, core }) => {
  const url = process.env.PREVIEW_URL
  if (!url) {
    core.setFailed('PREVIEW_URL env var is required')
    return
  }

  const { data: pr } = await github.rest.pulls.get({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: context.issue.number,
  })

  // context.sha is the merge commit on pull_request; name the branch head.
  const sha = pr.head.sha.slice(0, 7)
  const timestamp = new Date().toISOString()
  const section = [
    '## Preview Deployment',
    `✅ [${url}](${url})`,
    '',
    `_Last updated ${timestamp} · commit \`${sha}\`_`,
  ].join('\n')

  const body = pr.body || ''
  const headingRegex = /## Preview Deployment[\s\S]*?(?=\n## |$)/
  const newBody = headingRegex.test(body)
    ? body.replace(headingRegex, section)
    : `${body.trimEnd()}\n\n${section}\n`

  if (newBody === body) return

  await github.rest.pulls.update({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: context.issue.number,
    body: newBody,
  })
}
