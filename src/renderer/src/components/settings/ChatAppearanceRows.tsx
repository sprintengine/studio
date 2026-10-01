import React, { type JSX } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import {
  CHAT_CONTRAST_MAX,
  CHAT_CONTRAST_MIN,
  CHAT_CONTRAST_STEP,
  DEFAULT_CHAT_CONTRAST,
  type ChatWidth,
} from '../../types/appTheme'
import { ResetIcon } from '../AppIcons'
import { IconButton, SegmentedControl, SettingRow, Tooltip } from '../ui'
import { Slider, type SliderStop } from '../ui/Slider'

// Every step the stored value can take, named the way the readout shows it,
// so the slider's position, its announced value and the stored number are the
// same thing.
const CONTRAST_STOPS: SliderStop[] = Array.from(
  { length: (CHAT_CONTRAST_MAX - CHAT_CONTRAST_MIN) / CHAT_CONTRAST_STEP + 1 },
  (_, index) => {
    const value = CHAT_CONTRAST_MIN + index * CHAT_CONTRAST_STEP
    return { id: String(value), label: `${value}%` }
  },
)
const contrastIndex = (value: number) =>
  Math.max(
    0,
    CONTRAST_STOPS.findIndex((stop) => stop.id === String(value)),
  )
// Twenty-four stops drawn as ticks read as a dotted line, so only the ends and
// the default are marked: the default is the one stop worth finding by eye.
const CONTRAST_TICKS = [0, contrastIndex(DEFAULT_CHAT_CONTRAST), CONTRAST_STOPS.length - 1]

/**
 * The chat's two rows in Appearance → Interface: text contrast and column
 * width. Both apply as they change — the chat behind the settings is the
 * preview — through the store fields `useAppTheme` stamps on <html>.
 */
export function ChatAppearanceRows(): JSX.Element {
  const contrast = useWorkspaceStore((s) => s.appSettings.appearance.chatContrast)
  const setContrast = useWorkspaceStore((s) => s.setAppearanceChatContrast)
  const width = useWorkspaceStore((s) => s.appSettings.appearance.chatWidth)
  const setWidth = useWorkspaceStore((s) => s.setAppearanceChatWidth)
  const labelId = React.useId()
  const current = CONTRAST_STOPS[contrastIndex(contrast)]!
  return (
    <>
      <SettingRow
        label="Chat text contrast"
        labelId={labelId}
        help="Soften or strengthen the text in conversations and the composer, against the chat's own background."
      >
        <div className="w-40">
          <Slider
            ariaLabelledBy={labelId}
            stops={CONTRAST_STOPS}
            ticks={CONTRAST_TICKS}
            value={contrastIndex(contrast)}
            onChange={(index) => setContrast(Number(CONTRAST_STOPS[index]!.id))}
          />
        </div>
        {/* The value the position stands for, in figures that keep their
            width as it changes so the slider does not shift under the drag. */}
        <output aria-hidden="true" className="w-10 text-right text-meta tabular-nums text-[color:var(--text-muted)]">
          {current.label}
        </output>
        {/* The slot is kept when there is nothing to reset, so the slider
            does not jump sideways the moment it leaves the default. */}
        <span className="flex size-control-xs items-center justify-center">
          {contrast !== DEFAULT_CHAT_CONTRAST ? (
            <Tooltip content={`Reset to ${DEFAULT_CHAT_CONTRAST}%`}>
              <IconButton
                aria-label={`Reset chat text contrast to ${DEFAULT_CHAT_CONTRAST}%`}
                onClick={() => setContrast(DEFAULT_CHAT_CONTRAST)}
              >
                <ResetIcon className="icon-sm" />
              </IconButton>
            </Tooltip>
          ) : null}
        </span>
      </SettingRow>
      <SettingRow
        label="Chat width"
        help="How wide conversations and the composer grow in a wide pane. Full uses the whole pane."
      >
        <SegmentedControl<ChatWidth>
          ariaLabel="Chat width"
          items={[
            { value: 'comfortable', label: 'Comfortable' },
            { value: 'wide', label: 'Wide' },
            { value: 'full', label: 'Full' },
          ]}
          value={width}
          onChange={setWidth}
        />
      </SettingRow>
    </>
  )
}
