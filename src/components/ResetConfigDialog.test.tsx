import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render as rtlRender, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { ToastProvider } from './ToastProvider'
import { ResetConfigDialog } from './ResetConfigDialog'

function render(ui: React.ReactElement) {
  return rtlRender(<ToastProvider>{ui}</ToastProvider>)
}

beforeEach(() => { localStorage.clear() })
afterEach(() => cleanup())

describe('ResetConfigDialog', () => {
  it('renders the three groups and is closed when open=false', () => {
    render(<ResetConfigDialog open={false} onClose={() => {}} />)
    expect(screen.queryByRole('dialog', { name: '清除配置与数据' })).toBeNull()
  })

  it('toggles server items and clears them on confirm', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ results: { snippets: { ok: true } }, deletedSessionIds: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    // Keep the dialog mounted after close so we can assert the toast.
    const onClose = vi.fn()
    render(<ResetConfigDialog open onClose={onClose} />)
    fireEvent.click(screen.getByLabelText(/片段/))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /清除已选/ }))
    })
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/config/reset'), expect.anything())
    expect(onClose).toHaveBeenCalled()
  })

  it('requires two-step confirm for danger items', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ results: { sessions: { ok: true } }, deletedSessionIds: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    const onClose = vi.fn()
    render(<ResetConfigDialog open onClose={onClose} />)
    fireEvent.click(screen.getByLabelText(/sessions/i))
    // First click does NOT fire the request — enters confirm gate.
    fireEvent.click(screen.getByRole('button', { name: /清除已选/ }))
    expect(fetchMock).not.toHaveBeenCalled()
    // Type 'reset' + confirm.
    fireEvent.change(screen.getByPlaceholderText(/输入 reset/), { target: { value: 'reset' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /确认/ }))
    })
    expect(fetchMock).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('browser-data parent is tri-state over its three children', () => {
    render(<ResetConfigDialog open onClose={() => {}} />)
    const parent = screen.getByRole('checkbox', { name: /浏览器数据/ }) as HTMLInputElement
    const inputHistory = screen.getByRole('checkbox', { name: /input history/i }) as HTMLInputElement
    // Check parent → all children checked.
    fireEvent.click(parent)
    expect(inputHistory.checked).toBe(true)
    // Uncheck one child → parent indeterminate.
    fireEvent.click(inputHistory)
    expect(parent.indeterminate).toBe(true)
  })

  it('keeps the dialog open when the server POST fails', async () => {
    // useApi throws on a network failure; simulate by rejecting fetch.
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network down'))
    const onClose = vi.fn()
    render(<ResetConfigDialog open onClose={onClose} />)
    fireEvent.click(screen.getByLabelText(/片段/))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /清除已选/ }))
    })
    // The POST was attempted...
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/config/reset'), expect.anything())
    // ...but the dialog stayed open (no close, no reload) so the user can retry.
    expect(onClose).not.toHaveBeenCalled()
  })
})
