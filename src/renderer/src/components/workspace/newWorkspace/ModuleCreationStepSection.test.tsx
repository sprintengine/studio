import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// The module creation step's degradation contract (MC-1534): a throwing step
// Component must never block the hub — the boundary contains the throw, the
// host is told the step broke, and the broken render shows the standard
// inline notice so creation proceeds zero-config. This suite drives the real
// ModuleCreationStepSection in a client render because error boundaries only
// exist there (renderToStaticMarkup rethrows instead of catching).

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
})

const anyGlobal = globalThis as unknown as Record<string, unknown>
anyGlobal.window = dom.window
anyGlobal.document = dom.window.document
anyGlobal.navigator = dom.window.navigator
anyGlobal.HTMLElement = dom.window.HTMLElement
anyGlobal.HTMLInputElement = dom.window.HTMLInputElement
anyGlobal.Node = dom.window.Node
anyGlobal.MouseEvent = dom.window.MouseEvent
anyGlobal.getComputedStyle = dom.window.getComputedStyle
anyGlobal.IS_REACT_ACT_ENVIRONMENT = true

async function main(): Promise<void> {
  const React = (await import('react')).default
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { ModuleCreationStepSection } = await import('./ModuleCreationStepSection')
  type CreationStep = Parameters<typeof ModuleCreationStepSection>[0]['step']

  let failures = 0
  const check = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn()
      console.log(`ok - ${name}`)
    } catch (error) {
      failures += 1
      console.error(`not ok - ${name}`)
      console.error(error)
    }
  }

  // Mount the section the way the hub does: broken state lives in the host,
  // flipped by onBroken, so the throw → notice degradation is exercised
  // end-to-end rather than by poking the prop.
  async function mountStep(step: CreationStep): Promise<{
    container: HTMLElement
    setValueCalls: unknown[]
    unmount: () => Promise<void>
  }> {
    const setValueCalls: unknown[] = []
    function Host(): React.ReactElement {
      const [broken, setBroken] = React.useState(false)
      const [value, setValue] = React.useState<unknown>(undefined)
      return (
        <ModuleCreationStepSection
          step={step}
          value={value}
          setValue={(next) => {
            setValueCalls.push(next)
            setValue(next)
          }}
          broken={broken}
          onBroken={() => setBroken(true)}
        />
      )
    }
    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<Host />)
    })
    return {
      container,
      setValueCalls,
      unmount: async () => {
        await act(async () => {
          root.unmount()
        })
        container.remove()
      },
    }
  }

  await check('renders the registered heading, description, and live component', async () => {
    const mounted = await mountStep({
      id: 'city',
      heading: 'Which city?',
      description: 'The forecast panel opens on this city.',
      Component: ({ value, setValue }) =>
        React.createElement('input', {
          value: typeof value === 'string' ? value : '',
          onChange: (event: { target: { value: string } }) => setValue(event.target.value),
        }),
    })
    const heading = mounted.container.querySelector('h3')
    assert.equal(heading?.textContent, 'Which city?', 'registered heading renders')
    assert.ok(
      mounted.container.textContent?.includes('The forecast panel opens on this city.'),
      'registered description renders',
    )
    const input = mounted.container.querySelector('input')
    assert.ok(input, 'module component mounts')
    await mounted.unmount()
  })

  await check('a throwing component degrades to the inline notice instead of blocking', async () => {
    const naturalError = console.error
    // React logs the caught render error loudly; keep the test output honest
    // but quiet while the throw is expected.
    console.error = () => {}
    try {
      const mounted = await mountStep({
        id: 'boom',
        heading: 'Broken step',
        Component: () => {
          throw new Error('module step exploded')
        },
      })
      assert.ok(
        mounted.container.textContent?.includes(
          'This step hit an error and was skipped — the workspace is created with its default setup.',
        ),
        'onBroken flipped the host to the standard inline notice',
      )
      const heading = mounted.container.querySelector('h3')
      assert.equal(heading?.textContent, 'Broken step', 'heading survives the degradation')
      await mounted.unmount()
    } finally {
      console.error = naturalError
    }
  })

  await check('setValue flows the collected value back to the host', async () => {
    const mounted = await mountStep({
      id: 'city',
      heading: 'Which city?',
      Component: ({ setValue }) =>
        React.createElement('button', {
          type: 'button',
          onClick: () => setValue('Dublin'),
        }),
    })
    const button = mounted.container.querySelector('button')
    assert.ok(button, 'component mounts')
    await act(async () => {
      button?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    assert.deepEqual(mounted.setValueCalls, ['Dublin'], 'collected value reaches the host state')
    await mounted.unmount()
  })

  if (failures > 0) {
    console.error(`${failures} module creation step test(s) failed`)
    process.exit(1)
  }
  console.log('module creation step section tests passed')
}

void main()
