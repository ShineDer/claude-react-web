import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, within, cleanup } from '@testing-library/react'
import { PermissionDialog } from './PermissionDialog'
import type { PermissionRequest, PermissionMode } from '../types'

// Cleanup is registered globally in src/test-setup.ts. It matters here: before
// any of this, each test's <PermissionDialog> — and its `useFocusTrap`
// `document`-level `focusin` listener — stayed mounted and accumulated across
// tests. By the second test the leaked DOM + listeners produce an error with a
// deep stack that overflows vite-node's recursive `prepareStackTrace`
// source-map rewrite (the `/file:\/\/\/(\w:)?/` regex blows the stack), which
// cascades into unbounded unhandled rejections and an OOM that hangs the whole
// `vitest run`. Tearing down between tests keeps the stack shallow.
afterEach(() => {
  cleanup()
})

function planRequest(): Extract<PermissionRequest, { kind: 'permission' }> {
  return {
    kind: 'permission',
    id: 'p1',
    toolName: 'ExitPlanMode',
    input: { plan: 'Build the thing' },
    toolUseID: 'tu1',
    createdAt: 0,
  }
}

function toolRequest(): Extract<PermissionRequest, { kind: 'permission' }> {
  return {
    kind: 'permission',
    id: 'p2',
    toolName: 'Bash',
    input: { command: 'ls' },
    toolUseID: 'tu2',
    createdAt: 0,
  }
}

/** Text of the three plan-approval buttons, in DOM order. */
function buttonLabels(container: HTMLElement): string[] {
  return within(container)
    .getAllByRole('button')
    .map((b) => b.textContent?.trim() ?? '')
    // Drop the "Show raw input" toggle and the deny actions; the plan ordering
    // tests only assert on the approve labels. The UI copy is Chinese, so this
    // matches the approve labels by name rather than by an English prefix.
    .filter((t) => APPROVE_LABELS.includes(t.replace(/（当前）$/, '')))
}

const APPROVE_LABELS = ['批准并自动接受编辑', '批准并逐项审阅', '批准并跳过']

describe('PermissionDialog plan approval', () => {
  it('promotes the option matching the current mode to the primary (first) button', () => {
    const { container } = render(
      <PermissionDialog request={planRequest()} onDecide={vi.fn()} currentMode={'bypassPermissions'} />,
    )
    const labels = buttonLabels(container)
    // bypass option floated to front and marked (current).
    expect(labels[0]).toBe('批准并跳过（当前）')
    // The primary button carries btn-primary.
    const primary = within(container).getByRole('button', { name: /批准并跳过/ })
    expect(primary.className).toContain('btn-primary')
  })

  it('marks acceptEdits as current when that is the session mode', () => {
    const { container } = render(
      <PermissionDialog request={planRequest()} onDecide={vi.fn()} currentMode={'acceptEdits'} />,
    )
    expect(buttonLabels(container)[0]).toBe('批准并自动接受编辑（当前）')
  })

  it('falls back to the default ordering when current mode has no plan option (e.g. plan/dontAsk)', () => {
    const { container } = render(
      <PermissionDialog request={planRequest()} onDecide={vi.fn()} currentMode={'plan' as PermissionMode} />,
    )
    // No option equals 'plan', so original order is preserved; first is acceptEdits.
    const labels = buttonLabels(container)
    expect(labels[0]).toBe('批准并自动接受编辑')
    expect(labels.some((l) => l.includes('（当前）'))).toBe(false)
  })

  it('passes the chosen execution mode through onDecide', () => {
    const onDecide = vi.fn()
    const { container } = render(
      <PermissionDialog request={planRequest()} onDecide={onDecide} currentMode={'default'} />,
    )
    fireEvent.click(within(container).getByRole('button', { name: /批准并跳过/ }))
    expect(onDecide).toHaveBeenCalledWith({
      behavior: 'allow',
      persistForSession: false,
      planTargetMode: 'bypassPermissions',
    })
  })

  it('non-plan requests are unaffected (Allow once / Deny)', () => {
    const { container } = render(
      <PermissionDialog request={toolRequest()} onDecide={vi.fn()} currentMode={'bypassPermissions'} />,
    )
    const labels = within(container)
      .getAllByRole('button')
      .map((b) => b.textContent?.trim() ?? '')
    expect(labels).toContain('允许一次')
    expect(labels).toContain('拒绝')
    expect(labels.some((l) => l.startsWith('Approve'))).toBe(false)
  })

  it('renders a feedback input and two deny actions for a plan request', () => {
    const { container } = render(
      <PermissionDialog request={planRequest()} onDecide={vi.fn()} currentMode={'default'} />,
    )
    expect(within(container).getByPlaceholderText('告诉 Claude 要改什么')).toBeTruthy()
    expect(within(container).getByRole('button', { name: /发送反馈/i })).toBeTruthy()
    expect(within(container).getByRole('button', { name: /停止并接管/i })).toBeTruthy()
  })

  it('disables Send feedback when the input is empty', () => {
    const { container } = render(
      <PermissionDialog request={planRequest()} onDecide={vi.fn()} currentMode={'default'} />,
    )
    const btn = within(container).getByRole('button', { name: /发送反馈/i }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('Send feedback emits deny with message and no interrupt', () => {
    const onDecide = vi.fn()
    const { container } = render(
      <PermissionDialog request={planRequest()} onDecide={onDecide} currentMode={'default'} />,
    )
    const input = within(container).getByPlaceholderText('告诉 Claude 要改什么') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'add more tests' } })
    fireEvent.click(within(container).getByRole('button', { name: /发送反馈/i }))
    expect(onDecide).toHaveBeenCalledWith({
      behavior: 'deny',
      message: 'Plan denied by user. Feedback: add more tests',
    })
  })

  it('Stop & take over emits deny with interrupt:true and a stop message', () => {
    const onDecide = vi.fn()
    const { container } = render(
      <PermissionDialog request={planRequest()} onDecide={onDecide} currentMode={'default'} />,
    )
    fireEvent.click(within(container).getByRole('button', { name: /停止并接管/i }))
    expect(onDecide).toHaveBeenCalledWith({
      behavior: 'deny',
      message: 'Plan denied by user — stopping the turn.',
      interrupt: true,
    })
  })

  it('Esc on a plan dialog denies with interrupt:true', () => {
    const onDecide = vi.fn()
    const { container } = render(
      <PermissionDialog request={planRequest()} onDecide={onDecide} currentMode={'default'} />,
    )
    const dialog = container.querySelector('.perm-card') as HTMLElement
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onDecide).toHaveBeenCalledWith({
      behavior: 'deny',
      message: 'Plan denied by user — stopping the turn.',
      interrupt: true,
    })
  })
})

describe('PermissionDialog overlay scrollbar', () => {
  it('attaches the project overlay scrollbar to the modal-section scroll region (hides the native one)', () => {
    const { container } = render(
      <PermissionDialog request={planRequest()} onDecide={vi.fn()} currentMode={'default'} />,
    )
    const section = container.querySelector('.modal-section') as HTMLElement | null
    expect(section).toBeTruthy()
    // The overlay scrollbar hides the native scrollbar on the scroller it
    // attaches to — this is the contract that replaces the native 10px bar
    // with the project's self-built overlay thumb (matches the StreamingFooter
    // scrollbar test in transcript-chrome.test.tsx).
    expect(section!.hasAttribute('data-os-native-hidden')).toBe(true)
    // And it appends an overlay track as a sibling of the scroller inside the
    // .perm-card, floating the thumb over the plan card body.
    const card = container.querySelector('.perm-card')
    expect(card?.querySelector('.os-track')).toBeTruthy()
  })
})

describe('PermissionDialog Esc', () => {
  it('Esc on a plain tool dialog denies without interrupt (regression)', () => {
    const onDecide = vi.fn()
    const { container } = render(
      <PermissionDialog request={toolRequest()} onDecide={onDecide} currentMode={'default'} />,
    )
    const dialog = container.querySelector('.perm-card') as HTMLElement
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onDecide).toHaveBeenCalledWith({ behavior: 'deny' })
  })
})

describe('PermissionDialog minimize button', () => {
  it('renders a Minimize button for a non-plan request when onMinimize is provided', () => {
    const onMinimize = vi.fn()
    const { container } = render(
      <PermissionDialog request={toolRequest()} onDecide={vi.fn()} onMinimize={onMinimize} />,
    )
    const btn = within(container).getByRole('button', { name: '最小化' })
    expect(btn).toBeTruthy()
  })

  it('does not render a Minimize button when onMinimize is not provided', () => {
    const { container } = render(
      <PermissionDialog request={toolRequest()} onDecide={vi.fn()} />,
    )
    expect(within(container).queryByRole('button', { name: '最小化' })).toBeNull()
  })

  it('clicking the Minimize button calls onMinimize', () => {
    const onMinimize = vi.fn()
    const { container } = render(
      <PermissionDialog request={toolRequest()} onDecide={vi.fn()} onMinimize={onMinimize} />,
    )
    fireEvent.click(within(container).getByRole('button', { name: '最小化' }))
    expect(onMinimize).toHaveBeenCalledTimes(1)
  })

  it('still renders a Minimize button for a plan request when onMinimize is provided (regression)', () => {
    const onMinimize = vi.fn()
    const { container } = render(
      <PermissionDialog request={planRequest()} onDecide={vi.fn()} onMinimize={onMinimize} />,
    )
    expect(within(container).getByRole('button', { name: '最小化' })).toBeTruthy()
  })
})

describe('PermissionDialog security hints', () => {
  it('hides the session-wide allow when suppressAlwaysAllowRule is set', () => {
    const { container } = render(
      <PermissionDialog
        request={{ ...toolRequest(), suggestions: [{ type: 'addRules', rules: [] }], suppressAlwaysAllowRule: true }}
        onDecide={vi.fn()}
      />,
    )
    expect(within(container).queryByRole('button', { name: '本次会话允许' })).toBeNull()
    expect(container.textContent).toContain("isn't offered")
  })

  it('still offers the session-wide allow when suggestions are present and not suppressed', () => {
    const { container } = render(
      <PermissionDialog
        request={{ ...toolRequest(), suggestions: [{ type: 'addRules', rules: [] }] }}
        onDecide={vi.fn()}
      />,
    )
    expect(within(container).getByRole('button', { name: '本次会话允许' })).toBeTruthy()
  })

  it('opens on the decline option when defaultToNo is set', () => {
    const { container } = render(
      <PermissionDialog request={{ ...toolRequest(), defaultToNo: true }} onDecide={vi.fn()} />,
    )
    const deny = within(container).getByRole('button', { name: '拒绝' })
    expect(document.activeElement).toBe(deny)
  })

  it('shows the MCP server provenance when the request carries one', () => {
    const { container } = render(
      <PermissionDialog
        request={{ ...toolRequest(), mcpServer: { name: 'linear', source: 'project' } }}
        onDecide={vi.fn()}
      />,
    )
    expect(container.textContent).toContain('via linear')
    expect(container.textContent).toContain('(project)')
  })
})
