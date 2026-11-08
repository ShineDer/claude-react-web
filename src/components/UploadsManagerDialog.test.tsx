import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const mockGet = vi.fn()
const mockDelete = vi.fn()
const mockToast = { success: vi.fn(), error: vi.fn(), info: vi.fn() }

vi.mock('../hooks/useApi', () => ({
  api: {
    get: (...a: unknown[]) => mockGet(...a),
    delete: (...a: unknown[]) => mockDelete(...a),
  },
}))
vi.mock('../hooks/useToast', () => ({
  useToast: () => mockToast,
}))

// Import AFTER the mocks.
import { UploadsManagerDialog } from './UploadsManagerDialog'

const ROWS = [
  { id: 'a', path: '/p/claude-web-uploads/1-a.txt', cwd: '/p', name: 'a.txt', size: 1024, uploadedAt: Date.now(), sessionTitle: 'Alpha', exists: true },
  { id: 'b', path: '/p/claude-web-uploads/2-b.txt', cwd: '/p', name: 'b.txt', size: 2048, uploadedAt: Date.now(), sessionTitle: 'Beta', exists: false },
]

beforeEach(() => {
  vi.clearAllMocks()
  mockGet.mockResolvedValue({ uploads: ROWS })
  mockDelete.mockResolvedValue({ ok: true })
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  })
})
afterEach(cleanup)

describe('UploadsManagerDialog', () => {
  it('renders rows, stats, and the missing badge', async () => {
    render(<UploadsManagerDialog open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy())
    expect(screen.getByText(/2 files/)).toBeTruthy()
    expect(screen.getByText(/缺失/i, { selector: '.uploads-missing-badge' })).toBeTruthy()
  })

  it('filter narrows rows by name / cwd / 会话标题', async () => {
    render(<UploadsManagerDialog open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy())
    fireEvent.change(screen.getByPlaceholderText(/按名称/), { target: { value: 'Beta' } })
    expect(screen.queryByText('a.txt')).toBeNull()
    expect(screen.getByText('b.txt')).toBeTruthy()
  })

  it('empty state when there are no uploads', async () => {
    mockGet.mockResolvedValue({ uploads: [] })
    render(<UploadsManagerDialog open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/no files uploaded yet/i)).toBeTruthy())
  })

  it('error state with retry', async () => {
    mockGet.mockRejectedValueOnce(new Error('boom'))
    render(<UploadsManagerDialog open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/boom/)).toBeTruthy())
    mockGet.mockResolvedValue({ uploads: ROWS })
    fireEvent.click(screen.getByRole('button', { name: /重试/i }))
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy())
  })

  it('copy path writes the absolute path to the clipboard', async () => {
    render(<UploadsManagerDialog open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy())
    fireEvent.click(screen.getAllByRole('button', { name: /复制路径/ })[0])
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/p/claude-web-uploads/1-a.txt'),
    )
    expect(mockToast.success).toHaveBeenCalled()
  })

  it('delete flow: row Delete opens ConfirmDialog, confirming deletes + refetches', async () => {
    render(<UploadsManagerDialog open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy())

    // Row buttons say "删除文件"; the ConfirmDialog's confirm button is the
    // only accessible name exactly "删除" once the dialog is open.
    fireEvent.click(screen.getAllByRole('button', { name: /^删除文件$/ })[0])
    // ConfirmDialog mounted with the file path in the message.
    expect(screen.getByText('/p/claude-web-uploads/1-a.txt')).toBeTruthy()
    expect(screen.queryByText('b.txt')).toBeTruthy() // list still behind the confirm

    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('/uploads/a'))
    expect(mockGet).toHaveBeenCalledTimes(2) // initial + refresh
  })

  it('clean missing entries: button only when missing rows exist; batch deletes each', async () => {
    render(<UploadsManagerDialog open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/清理缺失条目/)).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /清理缺失条目/ }))
    fireEvent.click(screen.getByRole('button', { name: /clean 1 entry/i }))
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('/uploads/b'))
  })
})
