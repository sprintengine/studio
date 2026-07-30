import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { FOCUS_RING_CLASS, TruncatedText } from '../../ui'
import type { GuidedInterviewDecision, GuidedInterviewQuestion } from './interviewProtocol'

// Native rendering of the structured specialist interview: resolved decisions
// as a dense list, the current question as a card with clickable options. The
// card is always derived from the parsed stream — never from local interaction
// state — so the terminal and the card can both answer the same question
// without disagreeing.

export function ResolvedDecisionsList({
  decisions,
}: {
  decisions: GuidedInterviewDecision[]
}) {
  if (decisions.length === 0) return null
  return (
    <div className="flex flex-col px-3.5 pt-2.5 pb-1.5">
      <span className="pb-1 text-[11px] font-medium text-[color:var(--text-muted)]">Resolved</span>
      {decisions.map((decision) => (
        <div
          key={decision.id}
          className="flex min-w-0 items-baseline gap-2 py-0.5 text-[12px] leading-5"
        >
          {decision.question ? (
            <span className="max-w-[45%] shrink-0 truncate text-[color:var(--text-subtle)]">
              {decision.question}
            </span>
          ) : null}
          <TruncatedText as="span" text={decision.label} className="min-w-0 text-[color:var(--text-default)]" />
        </div>
      ))}
    </div>
  )
}

export function InterviewQuestionCard({
  question,
  onAnswer,
  answerPending,
}: {
  question: GuidedInterviewQuestion
  onAnswer: (answerText: string) => void
  /** True after an answer was sent and before the stream resolves it. */
  answerPending: boolean
}) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [otherSelected, setOtherSelected] = useState(false)
  const [otherText, setOtherText] = useState('')
  const optionRefs = useRef<Array<HTMLDivElement | null>>([])

  // Selection state resets per question; the card never carries a choice over.
  useEffect(() => {
    setSelectedIndex(0)
    setOtherSelected(false)
    setOtherText('')
  }, [question.id])

  const submit = () => {
    if (answerPending) return
    if (otherSelected) {
      const trimmed = otherText.trim()
      if (trimmed) onAnswer(trimmed)
      return
    }
    const option = question.options[selectedIndex]
    if (option) onAnswer(option.key)
  }

  const focusOption = (index: number) => {
    const clamped = Math.max(0, Math.min(question.options.length - 1, index))
    setSelectedIndex(clamped)
    setOtherSelected(false)
    optionRefs.current[clamped]?.focus()
  }

  const onOptionKeyDown = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        focusOption(index + 1)
        break
      case 'ArrowUp':
        event.preventDefault()
        focusOption(index - 1)
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        setSelectedIndex(index)
        setOtherSelected(false)
        submit()
        break
      default:
        break
    }
  }

  return (
    <div className="border-t border-[color:var(--border-subtle)] px-3.5 py-3">
      <div className="text-[13px] font-medium leading-5 text-[color:var(--text-strong)]">
        {question.question}
      </div>
      <div role="radiogroup" aria-label={question.question} className="mt-2.5 flex flex-col gap-1.5">
        {question.options.map((option, index) => {
          const selected = !otherSelected && index === selectedIndex
          return (
            <div
              key={`${question.id}:${option.key}`}
              ref={(element) => {
                optionRefs.current[index] = element
              }}
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => {
                setSelectedIndex(index)
                setOtherSelected(false)
              }}
              onKeyDown={(event) => onOptionKeyDown(event, index)}
              className={`
                flex cursor-pointer flex-col gap-0.5 rounded-md border px-3 py-2 outline-none
                transition-colors focus-visible:focus-ring
                ${
                  selected
                    ? 'border-[color:var(--border-strong)] bg-[color:var(--bg-selected)]'
                    : 'border-[color:var(--border-subtle)] hover:bg-[color:var(--bg-hover)]'
                }
              `}
            >
              <span className="flex items-baseline gap-2 text-[12px] font-medium text-[color:var(--text-strong)]">
                {option.label}
                {option.recommended ? (
                  <span className="font-normal text-[color:var(--text-muted)]">Recommended</span>
                ) : null}
              </span>
              {option.detail ? (
                <span className="text-[12px] leading-5 text-[color:var(--text-muted)]">
                  {option.detail}
                </span>
              ) : null}
            </div>
          )
        })}
        {question.allowOther ? (
          <div
            className={`
              flex items-center gap-2 rounded-md border border-dashed px-3 py-2
              ${
                otherSelected
                  ? 'border-[color:var(--accent-primary)]'
                  : 'border-[color:var(--border-default)]'
              }
            `}
          >
            <input
              type="text"
              value={otherText}
              placeholder="Other — type your own answer"
              onFocus={() => setOtherSelected(true)}
              onChange={(event) => {
                setOtherSelected(true)
                setOtherText(event.target.value)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  submit()
                }
              }}
              className={`
                w-full bg-transparent text-[12px] text-[color:var(--text-default)]
                placeholder:text-[color:var(--text-subtle)] ${FOCUS_RING_CLASS}
              `}
            />
          </div>
        ) : null}
      </div>
      <div className="mt-2.5 flex items-center justify-end gap-3">
        {answerPending ? (
          <span className="text-[12px] text-[color:var(--text-subtle)]">
            Answer sent. Waiting for the specialist.
          </span>
        ) : null}
        <button
          type="button"
          onClick={submit}
          disabled={answerPending || (otherSelected && !otherText.trim())}
          className="
            inline-flex h-8 items-center rounded-md bg-[color:var(--accent-primary)] px-3.5
            text-[12px] font-semibold text-[color:var(--bg-app)] transition-colors
            hover:bg-[color:var(--accent-primary-hover)]
            disabled:cursor-not-allowed disabled:bg-[color:var(--bg-surface-raised)] disabled:text-[color:var(--text-disabled)]
            focus-visible:focus-ring
          "
        >
          Answer
        </button>
      </div>
    </div>
  )
}
