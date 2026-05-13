import React from 'react'
import { FOCUS_RING_CLASS } from './tokens'

type ButtonBase = React.ButtonHTMLAttributes<HTMLButtonElement>

const SHARED =
  'interactive inline-flex items-center justify-center gap-1.5 rounded-[5px] font-medium ' +
  'disabled:cursor-not-allowed disabled:opacity-45'

const SIZE: Record<'sm' | 'md', string> = {
  sm: 'h-7 px-2 text-[12px]',
  md: 'h-8 px-3 text-[12px]',
}

type SizedButtonProps = ButtonBase & { size?: 'sm' | 'md' }

export function PrimaryButton({ className, size = 'sm', type, ...rest }: SizedButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      {...rest}
      className={[
        SHARED,
        SIZE[size],
        'bg-[color:var(--accent-primary)] text-[color:var(--text-on-accent)]',
        'hover:bg-[color:var(--accent-primary-hover)]',
        FOCUS_RING_CLASS,
        className ?? '',
      ].join(' ')}
    />
  )
}

export function GhostButton({ className, size = 'sm', type, ...rest }: SizedButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      {...rest}
      className={[
        SHARED,
        SIZE[size],
        'bg-transparent text-[color:var(--text-muted)]',
        'hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]',
        FOCUS_RING_CLASS,
        className ?? '',
      ].join(' ')}
    />
  )
}

type IconButtonProps = ButtonBase & {
  /** Required: icon-only buttons must expose an accessible name. */
  'aria-label': string
  size?: 'sm' | 'md'
}

const ICON_SIZE: Record<'sm' | 'md', string> = {
  sm: 'h-6 w-6 text-[12px]',
  md: 'h-7 w-7 text-[13px]',
}

export function IconButton({ className, size = 'sm', children, type, ...rest }: IconButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      {...rest}
      className={[
        'interactive inline-flex items-center justify-center rounded-[5px]',
        ICON_SIZE[size],
        'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]',
        'disabled:cursor-not-allowed disabled:opacity-45',
        FOCUS_RING_CLASS,
        className ?? '',
      ].join(' ')}
    >
      {children}
    </button>
  )
}
