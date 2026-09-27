import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { SkillsAndMcpsPicker } from './SkillsAndMcpsPicker'

test('the Skills trigger draws its star, so the label has no blank slot before it', () => {
  for (const includeMcps of [true, false]) {
    const markup = renderToStaticMarkup(
      createElement(SkillsAndMcpsPicker, {
        workspaceRoot: '/Users/dev/project',
        pluginId: null,
        skills: [],
        onSkillsChange: () => undefined,
        mcpServers: [],
        onMcpServersChange: () => undefined,
        includeMcps,
      }),
    )
    const glyph = /<svg[^>]*>/.exec(markup)?.[0] ?? ''
    // An unfilled star with no stroke paints nothing at all: that was the gap.
    expect(glyph).toContain('stroke="currentColor"')
    expect(markup).toContain(includeMcps ? 'Skills &amp; MCPs' : 'Skills')
  }
})
