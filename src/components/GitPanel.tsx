// Per-session Git overlay — interactive view of branch state, file
// changes, recent commits, stashes, and branch operations. Mounted as a
// sibling of <SettingsPanel> inside the Chat panel; the parent (Chat.tsx)
// wraps us in a `.git-overlay` backdrop whose click-outside / Escape
// handling matches SettingsPanel's exactly.
//
// Capabilities:
//   - Status: staged / unstaged / untracked sections with per-row
//     stage / unstage / discard and section-level bulk actions
//   - Commit form: message textarea + Commit / Amend; an AI button on
//     the "This session" section pre-fills the textarea from the
//     gitStartSha…HEAD diff
//   - Branches: current + list + new branch + checkout with optional
//     auto-stash on conflict
//   - Stashes: list with pop / drop + "stash all changes"
//   - In-progress state banners (merge / rebase / cherry-pick) with
//     abort buttons
//
// All destructive operations (discard, drop, abort, amend, force
// checkout) are gated by <ConfirmDialog>.

import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useGitDiff, useGitLog, useGitBranches, useGitStashes, gitDiffQuery } from '../hooks/useGitStatus'
import { useGitWrite } from '../hooks/useGitWrite'
import { api } from '../hooks/useApi'
import { ConfirmDialog } from './ConfirmDialog'
import { FileViewer } from './FileViewer'
import { GitFileRow } from './GitFileRow'
import { CommitRow } from './GitCommitRows'
import { isWriteKeyInert } from './git-keyboard'
import { AnimatedDetails } from './AnimatedCollapse'
import { Tooltip } from './Tooltip'
import { IconX, IconSparkles, IconChevronRight, IconCheck, IconAlertTriangle, IconRefresh, IconLoader, IconGitBranch, IconArrowUp, IconArrowDown, IconRotateCcw, IconSearch } from './icons/ToolIcons'
import { Skeleton } from './Skeleton'
import { useToast } from '../hooks/useToast'
import { useOverlayScrollbar } from '../hooks/useOverlayScrollbar'
import { AnimatePresence } from 'motion/react'
import type {
  GitCommitResponse,
  GitDiff,
  GitFileEntry,
  GitRangeFile,
  GitStatusResponse,
} from '../../shared/git-types'
import { gitStatusTitle } from '../utils/git-status'
import { formatError } from '../utils/format-error'

interface Props {
  /** Session id powering the per-session POST routes (writes) and WS
   *  subscription (auto-refresh). Required for any of the write
   *  operations to function. */
  sessionId: string
  /** Working directory the panel is operating against. Always defined
   *  in normal flow (the chip isn't rendered without one), but accept
   *  undefined defensively so a cwd swap mid-render doesn't crash. */
  cwd: string | undefined
  /** Latest status snapshot from useGitStatus. May be null while the
   *  initial fetch is in flight, or { isRepo: false } on a race. */
  status: GitStatusResponse | null
  loading: boolean
  error: string | null
  onRefresh: () => void
  onClose: () => void
}

/** Aggregate insertion/deletion counts across a set of file entries. */
interface ChangeTotals {
  insertions: number
  deletions: number
}

/** Sum the per-file numstat counts into a single total. Files without
 *  counts (untracked, binary) contribute zero. */
function sumChanges(files: GitFileEntry[]): ChangeTotals {
  let insertions = 0
  let deletions = 0
  for (const f of files) {
    insertions += f.insertions ?? 0
    deletions += f.deletions ?? 0
  }
  return { insertions, deletions }
}

/** Confirmation dialog state — driven by file-row and section actions
 *  that need user sign-off before mutating. The whole structure gets
 *  cleared on confirm or cancel. */
interface ConfirmState {
  title: string
  message: React.ReactNode
  confirmLabel: string
  destructive?: boolean
  onConfirm: () => Promise<void>
}

export const GitPanel = memo(function GitPanel({ sessionId, cwd, status, loading, error, onRefresh, onClose }: Props) {
  const writeOps = useGitWrite(sessionId)
  const setPanelOs = useOverlayScrollbar({ autoHide: 'leave' })
  // Git op failures used to render an in-panel error strip; they now
  // surface as global toasts so the user sees them even if they've
  // already moved off the Git overlay.
  const toast = useToast()
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  // File currently open in the read-only content viewer ({absPath, name}).
  const [viewing, setViewing] = useState<{ absPath: string; name: string } | null>(null)
  // File-filter query and keyboard-selection index across the visible rows.
  const [filter, setFilter] = useState('')
  const [selectedIdx, setSelectedIdx] = useState(0)
  // Expanded commit accordion (one at a time) + its file-list cache. The
  // cache lives HERE, not per row, so collapsing a commit (or the whole
  // Recent-commits section) and re-expanding never refetches. Held in state
  // rather than a ref because it is READ during render (the keyboard list
  // folds the open commit's files in); the instance is created once and only
  // ever mutated by useCachedCommitFiles' write-through, never replaced.
  const [expandedCommit, setExpandedCommit] = useState<string | null>(null)
  const [commitFileCache] = useState(() => new Map<string, GitCommitResponse>())
  const panelRef = useRef<HTMLElement | null>(null)

  // Focus the panel on open so ↑↓/s/u/x/Enter keyboard selection works
  // immediately. The Overlay focus trap leaves focus on the backdrop div (the
  // panel's PARENT), so keydown events bubble up from the backdrop and never
  // reach this <aside>. Focusing the aside puts the keydown origin inside the
  // panel — and inside the trap, which then leaves it alone.
  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  // Stable so memoized rows keep a fixed prop reference. Clicking a row moves
  // the keyboard-selection highlight to that row's flattened index.
  const selectRow = useCallback((index: number) => setSelectedIdx(index), [])

  // Commit accordion: one commit open at a time; clicking an open one collapses it.
  const toggleCommit = useCallback((hash: string) => {
    setExpandedCommit((prev) => (prev === hash ? null : hash))
  }, [])

  // Stable so memoized FileRow/UntrackedRow don't re-render when it's passed
  // down. Git status paths are relative to the WORK TREE ROOT (repoRoot),
  // not to the session cwd — anchoring against cwd would resolve the wrong
  // file whenever the session cwd is a subdirectory of the repo. readFile
  // wants an absolute path; the SDK resolves it against the session cwd.
  const handleOpenFile = useCallback(
    (path: string) => {
      const base = status && 'repoRoot' in status ? status.repoRoot : cwd
      const absPath = base ? `${base.replace(/\/+$/, '')}/${path}` : path
      setViewing({ absPath, name: path })
    },
    [cwd, status],
  )

  // Helper used inside event handlers: run a write op and translate
  // any rejection into a toast. Returns void so callers can `void run(...)`.
  async function runOp(label: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn()
    } catch (err) {
      const msg = formatError(err)
      toast.error(`${label}: ${msg}`)
    }
  }

  /** Run a write op behind a ConfirmDialog. The dialog stays mounted
   *  while the op is in flight (busy) and only unmounts after the
   *  promise settles, so a slow git command doesn't visually jump. */
  function askThenRun(state: Omit<ConfirmState, 'onConfirm'>, fn: () => Promise<unknown>, errLabel: string) {
    setConfirm({
      ...state,
      onConfirm: async () => {
        setConfirmBusy(true)
        try {
          await fn()
        } catch (err) {
          const msg = formatError(err)
          toast.error(`${errLabel}: ${msg}`)
        } finally {
          setConfirmBusy(false)
          setConfirm(null)
        }
      },
    })
  }

  // ── Empty / error states ────────────────────────────────────────
  if (error) {
    return (
      <aside className="git-panel" role="region" aria-label="Git">
        <header className="git-panel-header">
          <span className="git-panel-branch"><IconGitBranch size={13} /> git</span>
          <span className="git-panel-spacer" />
          <Tooltip label="刷新" placement="bottom">
            <button className="git-panel-icon-btn" onClick={onRefresh} aria-label="刷新"><IconRefresh size={14} /></button>
          </Tooltip>
          <Tooltip label="关闭" placement="bottom">
            <button className="git-panel-icon-btn" onClick={onClose} aria-label="关闭"><IconX size={14} /></button>
          </Tooltip>
        </header>
        <div className="git-panel-empty">
          <p className="git-panel-error">{error}</p>
          <button className="git-panel-action" onClick={onRefresh}>重试</button>
        </div>
      </aside>
    )
  }

  if (status && status.isRepo === false) {
    return (
      <aside className="git-panel" role="region" aria-label="Git">
        <header className="git-panel-header">
          <span className="git-panel-branch"><IconGitBranch size={13} /> git</span>
          <span className="git-panel-spacer" />
          <Tooltip label="关闭" placement="bottom">
            <button className="git-panel-icon-btn" onClick={onClose} aria-label="关闭"><IconX size={14} /></button>
          </Tooltip>
        </header>
        <div className="git-panel-empty">
          <p>不是 Git 仓库。</p>
        </div>
      </aside>
    )
  }

  if (!status) {
    return (
      <aside className="git-panel" role="region" aria-label="Git">
        <header className="git-panel-header">
          <span className="git-panel-branch"><IconGitBranch size={13} /> …</span>
          <span className="git-panel-spacer" />
          <Tooltip label="关闭" placement="bottom">
            <button className="git-panel-icon-btn" onClick={onClose} aria-label="关闭"><IconX size={14} /></button>
          </Tooltip>
        </header>
        <div className="git-panel-empty">
          <p>正在加载 Git 状态…</p>
        </div>
      </aside>
    )
  }

  // ── Repo state ──────────────────────────────────────────────────
  const inProgress = status.state !== 'clean' && status.state !== 'dirty'

  // Aggregate line-change totals across every changed file. Staged and
  // unstaged are separate diffs, so a file that's both staged AND further
  // modified contributes from both buckets — that matches what the user
  // sees if they expand each section. Untracked files have no diff counts.
  const totals = sumChanges([...status.staged, ...status.unstaged])

  // ── Filter + keyboard selection ───────────────────────────────────
  const totalFiles = status.staged.length + status.unstaged.length + status.untracked.length
  const filterQ = filter.trim().toLowerCase()
  const matchesFilter = (path: string) => !filterQ || path.toLowerCase().includes(filterQ)

  const unstagedVisible = status.unstaged.filter((f) => matchesFilter(f.path))
  const stagedVisible = status.staged.filter((f) => matchesFilter(f.path))
  const untrackedVisible = status.untracked.filter((f) => matchesFilter(f.path))

  type Selectable =
    | { kind: 'unstaged' | 'staged' | 'untracked'; file: GitFileEntry }
    | { kind: 'commit-file'; file: GitRangeFile; commitHash: string }

  // The keyboard list must see the expanded commit's file rows as soon as
  // they land: the cache is written from CommitRow's effect (a child state
  // update) which does NOT re-render GitPanel, so a render-captured array
  // would keep them unreachable until an unrelated state change. Rebuild
  // from the live Map — the three worktree lists only change on a
  // re-render anyway, so closing over them is safe.
  function buildSelectable(): Selectable[] {
    const rows: Selectable[] = [
      ...unstagedVisible.map((file) => ({ kind: 'unstaged' as const, file })),
      ...stagedVisible.map((file) => ({ kind: 'staged' as const, file })),
      ...untrackedVisible.map((file) => ({ kind: 'untracked' as const, file })),
    ]
    if (expandedCommit) {
      const commitFiles = commitFileCache.get(expandedCommit)?.files ?? []
      for (const file of commitFiles) {
        rows.push({ kind: 'commit-file', file, commitHash: expandedCommit })
      }
    }
    return rows
  }
  const selectable = buildSelectable()
  const selIdx = Math.min(selectedIdx, Math.max(selectable.length - 1, 0))
  const selected = selectable[selIdx]

  // ↑↓ moves the selection highlight; s/u/x stage/unstage/discard the
  // selected row (x is confirm-gated); Enter toggles the row's diff via
  // the existing toggle button. Guarded so typing in the filter input or
  // commit textarea never triggers these.
  function handleKeyDown(e: React.KeyboardEvent<HTMLElement>) {
    const target = e.target as HTMLElement
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
    // Don't run git shortcuts while the read-only file viewer modal is open.
    if (viewing) return
    // Live rebuild (see buildSelectable) — the commit's files may have
    // landed in the cache since this render.
    const rows = buildSelectable()
    if (rows.length === 0) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx((i) => Math.min(i + 1, rows.length - 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIdx((i) => Math.max(i - 1, 0)); return }
    const curIdx = Math.min(selectedIdx, Math.max(rows.length - 1, 0))
    const selected = rows[curIdx]
    if (!selected) return
    // s/u/x mutate the working tree — inert on read-only commit file rows.
    if ((e.key === 's' || e.key === 'u' || e.key === 'x') && isWriteKeyInert(selected.kind)) return
    if (e.key === 's') {
      e.preventDefault()
      if (selected.kind !== 'staged') void runOp('Stage', () => writeOps.stage([selected.file.path]))
    } else if (e.key === 'u') {
      e.preventDefault()
      if (selected.kind === 'staged') void runOp('Unstage', () => writeOps.unstage([selected.file.path]))
    } else if (e.key === 'x') {
      e.preventDefault()
      const untracked = selected.kind === 'untracked'
      askThenRun(
        {
          title: untracked ? '删除未跟踪的文件？' : '丢弃更改？',
          message: untracked
            ? (
              <>
                <p>Permanently remove <code>{selected.file.path}</code> from disk.</p>
                <p><strong>此文件未被 git 跟踪 — 无法恢复。</strong></p>
              </>
            )
            : <>Revert <code>{selected.file.path}</code> to its committed state. This cannot be undone.</>,
          confirmLabel: untracked ? '删除文件' : '丢弃',
          destructive: true,
        },
        () => writeOps.discard([selected.file.path], untracked),
        untracked ? '删除' : '丢弃',
      )
    } else if (e.key === 'Enter') {
      e.preventDefault()
      panelRef.current?.querySelector<HTMLButtonElement>('.git-file-row.selected .git-file-row-toggle')?.click()
    }
  }

  // Section action helpers — each builds a Promise then routes errors to
  // the toast or, for destructive ones, to a ConfirmDialog.
  function stageAll(files: GitFileEntry[]) {
    if (files.length === 0) return
    void runOp('Stage all', () => writeOps.stage(files.map((f) => f.path)))
  }
  function unstageAll(files: GitFileEntry[]) {
    if (files.length === 0) return
    void runOp('Unstage all', () => writeOps.unstage(files.map((f) => f.path)))
  }
  function discardAllUnstaged(files: GitFileEntry[]) {
    if (files.length === 0) return
    askThenRun(
      {
        title: '丢弃所有更改？',
        message: (
          <>
            <p>This will revert {files.length} file{files.length === 1 ? '' : 's'} to their last committed state.</p>
            <p><strong>此操作无法撤销。</strong></p>
          </>
        ),
        confirmLabel: '丢弃',
        destructive: true,
      },
      () => writeOps.discard(files.map((f) => f.path), false),
      'Discard',
    )
  }

  return (
    <aside className="git-panel" role="region" aria-label="Git" ref={panelRef} tabIndex={-1} onKeyDown={handleKeyDown}>
      <header className="git-panel-header">
        <Tooltip label={status.upstream ? `tracking ${status.upstream}` : 'no upstream'} placement="bottom">
          <span className="git-panel-branch">
            <IconGitBranch size={13} /> {status.detached ? 'detached' : (status.branch ?? 'unknown')}
          </span>
        </Tooltip>
        {(status.upstream || status.ahead > 0 || status.behind > 0) && (
          <span className="git-panel-sync-group">
            {(status.ahead > 0 || status.behind > 0) && (
              <Tooltip label={`${status.ahead} ahead · ${status.behind} behind`} placement="bottom">
                <span className="git-panel-syncs">
                  {status.ahead > 0 && <span className="git-panel-sync-up"><IconArrowUp size={11} />{status.ahead}</span>}
                  {status.behind > 0 && <span className="git-panel-sync-down"><IconArrowDown size={11} />{status.behind}</span>}
                </span>
              </Tooltip>
            )}
            {status.upstream && (
              <span className="git-panel-sync-actions">
                {status.behind > 0 && (
                  <Tooltip label="拉取（仅快进）" placement="bottom">
                    <button
                      className="git-panel-icon-btn"
                      disabled={writeOps.busyOps.has('pull') || writeOps.busyOps.has('push')}
                      onClick={(e) => {
                        e.preventDefault()
                        void runOp('Pull', async () => {
                          const result = await writeOps.pull()
                          if (!result.updated) toast.success('Already up to date')
                        })
                      }}
                      aria-label="从远程拉取"
                    >
                      <IconArrowDown size={13} />
                    </button>
                  </Tooltip>
                )}
                {status.ahead > 0 && (
                  <Tooltip label="推送到远程" placement="bottom">
                    <button
                      className="git-panel-icon-btn"
                      disabled={writeOps.busyOps.has('pull') || writeOps.busyOps.has('push')}
                      onClick={(e) => {
                        e.preventDefault()
                        void runOp('Push', () => writeOps.push())
                      }}
                      aria-label="推送到远程"
                    >
                      <IconArrowUp size={13} />
                    </button>
                  </Tooltip>
                )}
              </span>
            )}
          </span>
        )}
        <span className="git-panel-spacer" />
        {(totals.insertions > 0 || totals.deletions > 0) && (
          <Tooltip
            label={`${totals.insertions} insertion${totals.insertions === 1 ? '' : 's'}, ${totals.deletions} deletion${totals.deletions === 1 ? '' : 's'} across all changes`}
            placement="bottom"
          >
            <span className="git-panel-total-changes">
              {totals.insertions > 0 && <span className="git-file-additions">+{totals.insertions}</span>}
              {totals.deletions > 0 && <span className="git-file-deletions">−{totals.deletions}</span>}
            </span>
          </Tooltip>
        )}
        <Tooltip label={loading ? 'Refreshing…' : '刷新'} placement="bottom">
          <button
            className="git-panel-icon-btn"
            onClick={onRefresh}
            disabled={loading}
            aria-label="刷新"
          >
            {loading ? <IconLoader size={14} className="git-panel-spin" /> : <IconRefresh size={14} />}
          </button>
        </Tooltip>
        <Tooltip label="关闭" placement="bottom">
          <button className="git-panel-icon-btn" onClick={onClose} aria-label="关闭"><IconX size={14} /></button>
        </Tooltip>
      </header>

      {totalFiles > 0 && (
        <div className="git-panel-filter-bar">
          <IconSearch size={13} />
          <input
            type="text"
            className="git-panel-filter-input"
            aria-label="筛选文件"
            placeholder="筛选文件…"
            value={filter}
            onChange={(e) => { setFilter(e.target.value); setSelectedIdx(0) }}
          />
          {filter && (
            <button className="git-panel-icon-btn" onClick={() => setFilter('')} aria-label="清除筛选"><IconX size={12} /></button>
          )}
        </div>
      )}

      {inProgress && (
        <div className="git-panel-banner" role="alert">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><IconAlertTriangle size={12} /> {status.state} in progress</span>
          <span className="git-panel-spacer" />
          {status.state === 'merging' && (
            <button
              className="btn btn-danger git-banner-action"
              onClick={() =>
                askThenRun(
                  {
                    title: '中止合并？',
                    message: 'Discards in-progress merge state. Local changes that were not yet committed will be lost.',
                    confirmLabel: '中止合并',
                    destructive: true,
                  },
                  () => writeOps.abortMerge(),
                  'Abort merge',
                )
              }
            >中止合并</button>
          )}
          {status.state === 'rebasing' && (
            <button
              className="btn btn-danger git-banner-action"
              onClick={() =>
                askThenRun(
                  {
                    title: '中止变基？',
                    message: 'Returns the branch to its pre-rebase state. Any conflict resolutions made so far will be discarded.',
                    confirmLabel: '中止变基',
                    destructive: true,
                  },
                  () => writeOps.abortRebase(),
                  'Abort rebase',
                )
              }
            >中止变基</button>
          )}
        </div>
      )}

      <div className="git-panel-scroll" ref={setPanelOs}>
      {/* Section order: Changes (unstaged) is what the user is iterating
          on, so it sits at the top. Staged sits next — the holding pen
          on the way to commit. Untracked is collapsed by default;
          new files only matter once the user wants to add them. */}
      <Section
        title="更改"
        count={status.unstaged.length}
        changeTotals={sumChanges(status.unstaged)}
        defaultOpen={status.unstaged.length > 0}
        actions={status.unstaged.length > 0 ? (
          <>
            <button
              className="git-section-action"
              onClick={(e) => { e.preventDefault(); stageAll(status.unstaged) }}
              disabled={writeOps.busyOps.size > 0}
            >全部暂存</button>
            <button
              className="git-section-action danger"
              onClick={(e) => { e.preventDefault(); discardAllUnstaged(status.unstaged) }}
              disabled={writeOps.busyOps.size > 0}
            >全部丢弃</button>
          </>
        ) : null}
      >
        {status.unstaged.length === 0 ? (
          <EmptyHint>无未暂存更改</EmptyHint>
        ) : unstagedVisible.length === 0 ? (
          <EmptyHint>无匹配文件</EmptyHint>
        ) : (
          unstagedVisible.map((f, idx) => (
            <FileRow
              key={'u:' + f.path}
              file={f}
              cwd={cwd}
              staged={false}
              selected={selected?.kind === 'unstaged' && selected.file.path === f.path}
              selectIndex={idx}
              onSelect={selectRow}
              writeOps={writeOps}
              onError={(label, err) => toast.error(`${label}: ${err}`)}
              askConfirm={askThenRun}
              onOpenFile={handleOpenFile}
            />
          ))
        )}
      </Section>

      <Section
        title="已暂存"
        count={status.staged.length}
        changeTotals={sumChanges(status.staged)}
        defaultOpen={status.staged.length > 0}
        actions={status.staged.length > 0 ? (
          <button
            className="git-section-action"
            onClick={(e) => { e.preventDefault(); unstageAll(status.staged) }}
            disabled={writeOps.busyOps.size > 0}
          >全部取消暂存</button>
        ) : null}
      >
        {status.staged.length === 0 ? (
          <EmptyHint>无暂存更改</EmptyHint>
        ) : stagedVisible.length === 0 ? (
          <EmptyHint>无匹配文件</EmptyHint>
        ) : (
          stagedVisible.map((f, idx) => (
            <FileRow
              key={'s:' + f.path}
              file={f}
              cwd={cwd}
              staged
              selected={selected?.kind === 'staged' && selected.file.path === f.path}
              selectIndex={unstagedVisible.length + idx}
              onSelect={selectRow}
              writeOps={writeOps}
              onError={(label, err) => toast.error(`${label}: ${err}`)}
              askConfirm={askThenRun}
              onOpenFile={handleOpenFile}
            />
          ))
        )}
      </Section>

      <Section
        title="未跟踪"
        count={status.untracked.length}
        defaultOpen={false}
        actions={status.untracked.length > 0 ? (
          <button
            className="git-section-action"
            onClick={(e) => { e.preventDefault(); stageAll(status.untracked) }}
            disabled={writeOps.busyOps.size > 0}
          >全部暂存</button>
        ) : null}
      >
        {status.untracked.length === 0 ? (
          <EmptyHint>无未跟踪文件</EmptyHint>
        ) : untrackedVisible.length === 0 ? (
          <EmptyHint>无匹配文件</EmptyHint>
        ) : (
          untrackedVisible.map((f, idx) => (
            <UntrackedRow
              key={'?:' + f.path}
              file={f}
              selected={selected?.kind === 'untracked' && selected.file.path === f.path}
              selectIndex={unstagedVisible.length + stagedVisible.length + idx}
              onSelect={selectRow}
              writeOps={writeOps}
              onError={(label, err) => toast.error(`${label}: ${err}`)}
              askConfirm={askThenRun}
              onOpenFile={handleOpenFile}
            />
          ))
        )}
      </Section>

      <BranchesSection
        cwd={cwd}
        sessionId={sessionId}
        currentBranch={status.detached ? null : status.branch}
        writeOps={writeOps}
        onError={(label, err) => toast.error(`${label}: ${err}`)}
        askConfirm={askThenRun}
      />

      <StashesSection
        cwd={cwd}
        sessionId={sessionId}
        writeOps={writeOps}
        onError={(label, err) => toast.error(`${label}: ${err}`)}
        askConfirm={askThenRun}
      />

      <Section title="最近提交" count={null} defaultOpen={false}>
        <CommitList
          cwd={cwd}
          expandedCommit={expandedCommit}
          onToggleCommit={toggleCommit}
          commitFileCache={commitFileCache}
          selectedPath={selected?.kind === 'commit-file' ? selected.file.path : null}
          onSelectFile={(path) => {
            const rows = buildSelectable()
            const i = rows.findIndex((s) => s.kind === 'commit-file' && s.file.path === path)
            if (i >= 0) setSelectedIdx(i)
          }}
        />
      </Section>
      </div>

      <CommitBar
        canAmend={true}
        hasStaged={status.staged.length > 0}
        commit={writeOps.commit}
        generateCommitMessage={writeOps.generateCommitMessage}
        busy={writeOps.busyOps.has('commit') || writeOps.busyOps.has('commit:amend')}
        generateBusy={writeOps.busyOps.has('commit-message')}
        message={commitMessage}
        setMessage={setCommitMessage}
        readOnlySelection={selected?.kind === 'commit-file'}
        onError={(err) => toast.error(`Commit: ${err}`)}
        askConfirm={askThenRun}
      />

      <AnimatePresence>
        {confirm && (
          <ConfirmDialog
            key="confirm"
            title={confirm.title}
            message={confirm.message}
            confirmLabel={confirm.confirmLabel}
            destructive={confirm.destructive}
            busy={confirmBusy}
            onConfirm={confirm.onConfirm}
            onCancel={() => { if (!confirmBusy) setConfirm(null) }}
          />
        )}
      </AnimatePresence>

      {viewing && (
        <FileViewer
          open
          sessionId={sessionId}
          path={viewing.absPath}
          name={viewing.name}
          onClose={() => setViewing(null)}
        />
      )}
    </aside>
  )
})

// ── Section wrapper using native <details>/<summary> ──────────────────

interface SectionProps {
  title: string
  count: number | null
  defaultOpen: boolean
  children: React.ReactNode
  /** Optional buttons rendered to the right of the section title. */
  actions?: React.ReactNode
  /** Aggregate line-change counts for this section's files, shown as a
   *  +N −M badge beside the count. Omitted for sections without diffs. */
  changeTotals?: ChangeTotals
}

function Section({ title, count, defaultOpen, children, actions, changeTotals }: SectionProps) {
  const summary = (
    <>
      <IconChevronRight size={12} className="git-panel-chevron" aria-hidden />
      <span className="git-panel-section-title">{title}</span>
      {changeTotals && (changeTotals.insertions > 0 || changeTotals.deletions > 0) && (
        <span className="git-section-change-totals">
          {changeTotals.insertions > 0 && <span className="git-file-additions">+{changeTotals.insertions}</span>}
          {changeTotals.deletions > 0 && <span className="git-file-deletions">-{changeTotals.deletions}</span>}
        </span>
      )}
      {count !== null && <span className="git-panel-section-count">{count}</span>}
      {actions && (
        // Stop the click from bubbling into <summary> (which would
        // toggle the section). The outer wrapper preserves the
        // grid-end alignment.
        <span
          className="git-panel-section-actions"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {actions}
        </span>
      )}
    </>
  )

  return (
    <AnimatedDetails
      className="git-panel-section"
      defaultOpen={defaultOpen}
      summary={summary}
      contentClassName="git-panel-section-body"
    >
      {children}
    </AnimatedDetails>
  )
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return <div className="git-panel-section-empty">{children}</div>
}

// ── File rows ─────────────────────────────────────────────────────────

interface FileRowProps {
  file: GitFileEntry
  cwd: string | undefined
  staged: boolean
  /** Whether this row is the current keyboard-selection target. */
  selected: boolean
  /** Flattened index of this row in the keyboard-selection list. */
  selectIndex: number
  /** Move the keyboard selection to a flattened row index. */
  onSelect: (index: number) => void
  writeOps: ReturnType<typeof useGitWrite>
  onError: (label: string, err: string) => void
  askConfirm: (state: Omit<ConfirmState, 'onConfirm'>, fn: () => Promise<unknown>, errLabel: string) => void
  /** Open the file's current content in the read-only viewer. */
  onOpenFile: (path: string) => void
}

const FileRow = memo(function FileRow({ file, cwd, staged, selected, selectIndex, onSelect, writeOps, onError, askConfirm, onOpenFile }: FileRowProps) {
  // The diff fetch is armed on the first open attempt — GitFileRow calls
  // onFetchStart from its deferred-open toggle. The diff endpoint is one
  // git invocation per file, so we don't spend the request until the user
  // has actually asked for the row.
  const [fetchStarted, setFetchStarted] = useState(false)
  const { data: diff, loading, error } = useGitDiff(cwd, file.path, staged, fetchStarted)
  const handleFetchStart = useCallback(() => setFetchStarted(true), [])
  // Collapse exit completes → drop the latch so a later reopen re-fetches
  // instead of showing a stale worktree diff (the pre-refactor
  // onExitComplete={() => setRenderDiff(false)}).
  const handleFetchReset = useCallback(() => setFetchStarted(false), [])

  const stageBusy = writeOps.busyOps.has(`stage:${file.path}`)
  const unstageBusy = writeOps.busyOps.has(`unstage:${file.path}`)
  const discardBusy = writeOps.busyOps.has(`discard:${file.path}`)
  const anyBusy = stageBusy || unstageBusy || discardBusy

  // Full-diff escape hatch for a truncated preview (see DiffView's marker).
  // fetchFullText is stable for a given row so FullDiffViewer's open-effect
  // can't refetch on unrelated GitPanel re-renders.
  const fetchFullText = useCallback((signal?: AbortSignal): Promise<string> => {
    // Loud, not a silent fallback: the button only renders once a preview
    // diff loaded, and useGitDiff never loads one without a cwd — so a
    // missing cwd here is a real invariant break that must surface.
    if (!cwd) throw new Error('viewing a full diff requires a cwd')
    return api.get<GitDiff>(gitDiffQuery(cwd, file.path, staged, { full: true }), { signal }).then((d) => d.text)
  }, [cwd, file.path, staged])

  return (
    <GitFileRow
      status={file.status}
      path={file.path}
      renamedFrom={file.renamedFrom}
      insertions={file.insertions}
      deletions={file.deletions}
      selected={selected}
      onSelect={() => onSelect(selectIndex)}
      fetchStarted={fetchStarted}
      onFetchStart={handleFetchStart}
      onFetchReset={handleFetchReset}
      diff={{ data: diff, loading, error }}
      fetchFullText={fetchFullText}
      actions={(
        <>
          <Tooltip label="查看文件内容" placement="left">
            <button
              type="button"
              className="git-action-btn"
              aria-label="查看文件内容"
              onClick={(e) => { e.stopPropagation(); onOpenFile(file.path) }}
            ><IconSearch size={13} /></button>
          </Tooltip>
          {staged ? (
            <Tooltip label="取消暂存" placement="left">
              <button
                type="button"
                className="git-action-btn"
                aria-label="取消暂存"
                disabled={anyBusy}
                onClick={async () => {
                  try { await writeOps.unstage([file.path]) } catch (e) { onError('Unstage', (e as Error).message) }
                }}
              >−</button>
            </Tooltip>
          ) : (
            <>
              <Tooltip label="暂存" placement="left">
                <button
                  type="button"
                  className="git-action-btn"
                  aria-label="暂存"
                  disabled={anyBusy}
                  onClick={async () => {
                    try { await writeOps.stage([file.path]) } catch (e) { onError('Stage', (e as Error).message) }
                  }}
                >+</button>
              </Tooltip>
              <Tooltip label="丢弃更改" placement="left">
                <button
                  type="button"
                  className="git-action-btn danger"
                  aria-label="丢弃更改"
                  disabled={anyBusy}
                  onClick={() =>
                    askConfirm(
                      {
                        title: '丢弃更改？',
                        message: (
                          <>Revert <code>{file.path}</code> to its committed state. This cannot be undone.</>
                        ),
                        confirmLabel: '丢弃',
                        destructive: true,
                      },
                      () => writeOps.discard([file.path], false),
                      'Discard',
                    )
                  }
                >
                  <IconRotateCcw size={12} />
                </button>
              </Tooltip>
            </>
          )}
        </>
      )}
    />
  )
}, (prev, next) => {
  // Custom comparator: skip re-render when only writeOps reference changed
  // but the file's busy state is the same.
  if (prev.file !== next.file || prev.cwd !== next.cwd || prev.staged !== next.staged || prev.selected !== next.selected || prev.selectIndex !== next.selectIndex || prev.onSelect !== next.onSelect) return false
  const path = prev.file.path
  const prevBusy = prev.writeOps.busyOps.has(`stage:${path}`) || prev.writeOps.busyOps.has(`unstage:${path}`) || prev.writeOps.busyOps.has(`discard:${path}`)
  const nextBusy = next.writeOps.busyOps.has(`stage:${path}`) || next.writeOps.busyOps.has(`unstage:${path}`) || next.writeOps.busyOps.has(`discard:${path}`)
  return prevBusy === nextBusy
})

interface UntrackedRowProps {
  file: GitFileEntry
  /** Whether this row is the current keyboard-selection target. */
  selected: boolean
  /** Flattened index of this row in the keyboard-selection list. */
  selectIndex: number
  /** Move the keyboard selection to a flattened row index. */
  onSelect: (index: number) => void
  writeOps: ReturnType<typeof useGitWrite>
  onError: (label: string, err: string) => void
  askConfirm: (state: Omit<ConfirmState, 'onConfirm'>, fn: () => Promise<unknown>, errLabel: string) => void
  /** Open the file's current content in the read-only viewer. */
  onOpenFile: (path: string) => void
}

function UntrackedRow({ file, selected, selectIndex, onSelect, writeOps, onError, askConfirm, onOpenFile }: UntrackedRowProps) {
  const stageBusy = writeOps.busyOps.has(`stage:${file.path}`)
  const discardBusy = writeOps.busyOps.has(`discard:${file.path}`)
  const anyBusy = stageBusy || discardBusy
  return (
    <div className={`git-file-row untracked ${selected ? 'selected' : ''}`}>
      <div className="git-file-row-line" onClick={() => onSelect(selectIndex)}>
        <span className="git-file-row-toggle untracked-static" title={file.path}>
          <span className="git-file-status status-?" title={gitStatusTitle('?')}>?</span>
          <span className="git-file-path">
            {file.path}
          </span>
        </span>
        <div className="git-file-actions">
          <Tooltip label="查看文件内容" placement="left">
            <button
              type="button"
              className="git-action-btn"
              aria-label="查看文件内容"
              onClick={(e) => { e.stopPropagation(); onOpenFile(file.path) }}
            ><IconSearch size={13} /></button>
          </Tooltip>
          <Tooltip label="暂存" placement="left">
            <button
              type="button"
              className="git-action-btn"
              aria-label="暂存"
              disabled={anyBusy}
              onClick={async () => {
                try { await writeOps.stage([file.path]) } catch (e) { onError('Stage', (e as Error).message) }
              }}
            >+</button>
          </Tooltip>
          <Tooltip label="从磁盘删除" placement="left">
          <button
            type="button"
            className="git-action-btn danger"
            aria-label="从磁盘删除"
            disabled={anyBusy}
            onClick={() =>
              askConfirm(
                {
                  title: '删除未跟踪的文件？',
                  message: (
                    <>
                      <p>Permanently remove <code>{file.path}</code> from disk.</p>
                      <p><strong>此文件未被 git 跟踪 — 无法恢复。</strong></p>
                    </>
                  ),
                  confirmLabel: '删除文件',
                  destructive: true,
                },
                () => writeOps.discard([file.path], true),
                'Delete',
              )
            }
          ><IconX size={14} /></button>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}

// ── Commit bar (sticky footer) ────────────────────────────────────────

interface CommitBarProps {
  canAmend: boolean
  /** Whether anything is currently staged. Drives the Generate button's
   *  disabled state — the AI message is only meaningful when there's
   *  a staged diff to summarise; an empty staged area would 400 from
   *  the server and confuse the user. */
  hasStaged: boolean
  commit: ReturnType<typeof useGitWrite>['commit']
  generateCommitMessage: ReturnType<typeof useGitWrite>['generateCommitMessage']
  busy: boolean
  generateBusy: boolean
  message: string
  setMessage: (m: string) => void
  /** True when the keyboard selection is a read-only commit file row — the
   *  footer hint then drops the s/u/x verbs. */
  readOnlySelection: boolean
  onError: (err: string) => void
  askConfirm: (state: Omit<ConfirmState, 'onConfirm'>, fn: () => Promise<unknown>, errLabel: string) => void
}

function CommitBar({
  canAmend,
  hasStaged,
  commit,
  generateCommitMessage,
  busy,
  generateBusy,
  message,
  setMessage,
  readOnlySelection,
  onError,
  askConfirm,
}: CommitBarProps) {
  async function doCommit(amend: boolean) {
    if (!amend && !message.trim()) {
      onError('Commit message required')
      return
    }
    try {
      await commit(message, amend)
      setMessage('')
    } catch (e) {
      onError((e as Error).message)
    }
  }

  async function doGenerate() {
    try {
      const r = await generateCommitMessage()
      setMessage(r.message)
      if (r.fallback) {
        onError(
          'Used a local fallback message — Anthropic API was unreachable. Edit before committing.',
        )
      }
    } catch (e) {
      onError((e as Error).message)
    }
  }

  return (
    <footer className="git-commit-footer">
      <textarea
        className="git-commit-textarea"
        aria-label="提交信息"
        placeholder="提交信息… (⌘/Ctrl+Enter)"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={2}
        disabled={busy}
        onKeyDown={(e) => {
          // Cmd/Ctrl+Enter submits, mirroring the composer pattern.
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !busy) {
            e.preventDefault()
            void doCommit(false)
          }
        }}
      />
      <div className="git-commit-actions">
        <button
          type="button"
          className="btn"
          disabled={generateBusy || busy || !hasStaged}
          onClick={(e) => { e.preventDefault(); void doGenerate() }}
          title={
            hasStaged
              ? 'Generate a Conventional Commit message from the staged diff'
              : 'Stage some changes first to generate a commit message'
          }
        >
          {generateBusy ? '…' : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><IconSparkles size={12} /> Generate</span>}
        </button>
        {canAmend && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() =>
              askConfirm(
                {
                  title: '修改上一次提交？',
                  message: (
                    <>
                      <p>Replaces the previous commit with the staged changes (if any) and
                      {message.trim() ? ' the new message.' : ' keeps its existing message.'}</p>
                      <p>不要修改已推送到共享分支的提交。</p>
                    </>
                  ),
                  confirmLabel: 'Amend',
                  destructive: false,
                },
                () => doCommit(true),
                'Amend',
              )
            }
          >修改上一次提交</button>
        )}
        <span className="git-commit-hint" aria-hidden>
          {readOnlySelection ? '↑↓ select · Enter expand' : '↑↓ select · s stage · u unstage · x discard · Enter expand'}
        </span>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !message.trim()}
          onClick={() => doCommit(false)}
        >提交</button>
      </div>
    </footer>
  )
}

// ── Branches section ─────────────────────────────────────────────────

interface BranchesSectionProps {
  cwd: string | undefined
  sessionId: string
  currentBranch: string | null
  writeOps: ReturnType<typeof useGitWrite>
  onError: (label: string, err: string) => void
  askConfirm: (state: Omit<ConfirmState, 'onConfirm'>, fn: () => Promise<unknown>, errLabel: string) => void
}

function BranchesSection({ cwd, sessionId, currentBranch, writeOps, onError, askConfirm }: BranchesSectionProps) {
  const [open, setOpen] = useState(false)
  const branches = useGitBranches(cwd, sessionId, open)
  const [newBranchOpen, setNewBranchOpen] = useState(false)
  const [newName, setNewName] = useState('')

  /** Try checkout. On 409 (uncommitted-changes conflict), prompt for
   *  auto-stash. Other errors land in the toast. */
  async function tryCheckout(name: string) {
    try {
      await writeOps.checkout(name, false)
    } catch (e) {
      const err = e as Error & { status?: number }
      if (err.status === 409) {
        askConfirm(
          {
            title: '有未提交的更改，无法切换到此版本',
            message: (
              <>
                <p>Switching to <code>{name}</code> would overwrite uncommitted changes in your working tree.</p>
                <p>Auto-stash and switch? Your changes will be saved as <code>stash@{'{0}'}</code>.</p>
              </>
            ),
            confirmLabel: 'Auto-stash & switch',
            destructive: false,
          },
          () => writeOps.checkout(name, true),
          `Checkout ${name}`,
        )
      } else {
        onError(`Checkout ${name}`, err.message)
      }
    }
  }

  async function createNewBranch(checkout: boolean) {
    if (!newName.trim()) return
    try {
      await writeOps.createBranch(newName.trim(), checkout)
      setNewName('')
      setNewBranchOpen(false)
    } catch (e) {
      const err = e as Error & { status?: number }
      if (checkout && err.status === 409) {
        askConfirm(
          {
            title: '有未提交的更改，无法创建分支',
            message: (
              <>
                <p>Creating and switching to <code>{newName.trim()}</code> would overwrite uncommitted changes.</p>
                <p>Auto-stash and create? Your changes will be saved as <code>stash@{'{0}'}</code>.</p>
              </>
            ),
            confirmLabel: 'Auto-stash & create',
            destructive: false,
          },
          async () => {
            await writeOps.createBranch(newName.trim(), true, true)
            setNewName('')
            setNewBranchOpen(false)
          },
          `Create branch ${newName.trim()}`,
        )
      } else {
        onError('Create branch', err.message)
      }
    }
  }

  return (
    <AnimatedDetails
      className="git-panel-section"
      open={open}
      onOpenChange={setOpen}
      summary={(
        <>
        <span className="git-panel-section-title">分支</span>
        <span
          className="git-panel-section-actions"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="git-section-action"
            onClick={(e) => { e.preventDefault(); setNewBranchOpen((v) => !v) }}
          >+ new</button>
        </span>
        </>
      )}
    >
      <div className="git-panel-section-body">
        {newBranchOpen && (
          <div className="git-new-branch-form">
            <input
              type="text"
              className="git-new-branch-input"
              aria-label="新分支名称"
              placeholder="branch name…"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); void createNewBranch(true) }
                if (e.key === 'Escape') { e.preventDefault(); setNewBranchOpen(false); setNewName('') }
              }}
            />
            <button
              className="btn btn-primary"
              disabled={!newName.trim() || writeOps.busyOps.size > 0}
              onClick={() => createNewBranch(true)}
            >创建并检出</button>
            <button
              className="btn"
              disabled={!newName.trim() || writeOps.busyOps.size > 0}
              onClick={() => createNewBranch(false)}
            >创建</button>
          </div>
        )}
        {branches.loading && <Skeleton rows={3} className="git-section-skeleton" />}
        {branches.error && <div className="git-section-empty git-commits-error">{branches.error}</div>}
        {branches.data && branches.data.length === 0 && (
          <div className="git-section-empty">无本地分支</div>
        )}
        {branches.data && branches.data.map((b) => {
          const isCurrent = b.name === currentBranch
          const busy = writeOps.busyOps.has(`checkout:${b.name}`)
          return (
            <Tooltip
              key={b.name}
              label={b.upstream ? `tracks ${b.upstream}` : 'no upstream'}
              placement="top"
            >
              <button
                type="button"
                className={`git-branch-row ${isCurrent ? 'current' : ''}`}
                disabled={isCurrent || busy}
                onClick={() => tryCheckout(b.name)}
              >
                <span className="git-branch-mark">{isCurrent ? <IconCheck size={12} /> : ' '}</span>
                <span className="git-branch-name">{b.name}</span>
                {b.upstream && <span className="git-branch-upstream">→ {b.upstream}</span>}
              </button>
            </Tooltip>
          )
        })}
      </div>
    </AnimatedDetails>
  )
}

// ── Stashes section ──────────────────────────────────────────────────

interface StashesSectionProps {
  cwd: string | undefined
  sessionId: string
  writeOps: ReturnType<typeof useGitWrite>
  onError: (label: string, err: string) => void
  askConfirm: (state: Omit<ConfirmState, 'onConfirm'>, fn: () => Promise<unknown>, errLabel: string) => void
}

function StashesSection({ cwd, sessionId, writeOps, onError, askConfirm }: StashesSectionProps) {
  const [open, setOpen] = useState(false)
  const stashes = useGitStashes(cwd, sessionId, open)

  return (
    <AnimatedDetails
      className="git-panel-section"
      open={open}
      onOpenChange={setOpen}
      summary={(
        <>
        <span className="git-panel-section-title">贮藏</span>
        <span className="git-panel-section-count">{stashes.data?.length ?? '·'}</span>
        <span
          className="git-panel-section-actions"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="git-section-action"
            disabled={writeOps.busyOps.size > 0}
            onClick={async (e) => {
              e.preventDefault()
              try { await writeOps.stashCreate({ includeUntracked: true }) }
              catch (err) { onError('Stash all', (err as Error).message) }
            }}
          >全部贮藏</button>
        </span>
        </>
      )}
    >
      <div className="git-panel-section-body">
        {stashes.loading && <Skeleton rows={2} className="git-section-skeleton" />}
        {stashes.error && <div className="git-section-empty git-commits-error">{stashes.error}</div>}
        {stashes.data && stashes.data.length === 0 && (
          <div className="git-section-empty">无储藏</div>
        )}
        {stashes.data && stashes.data.map((s) => {
          const popBusy = writeOps.busyOps.has(`stash-pop:${s.index}`)
          const dropBusy = writeOps.busyOps.has(`stash-drop:${s.index}`)
          return (
            <div key={s.ref} className="git-stash-row">
              <code className="git-stash-ref">{s.ref}</code>
              <span className="git-stash-message">{s.message}</span>
              <div className="git-stash-actions">
                <Tooltip label="弹出（应用并移除）" placement="left">
                  <button
                    className="git-action-btn"
                    disabled={popBusy || dropBusy}
                    onClick={async () => {
                      try { await writeOps.stashPop(s.index) }
                      catch (err) { onError('Pop stash', (err as Error).message) }
                    }}
                    aria-label="弹出暂存"
                  >弹出</button>
                </Tooltip>
                <Tooltip label="丢弃（删除）" placement="left">
                  <button
                    className="git-action-btn danger"
                    disabled={popBusy || dropBusy}
                    onClick={() =>
                      askConfirm(
                        {
                          title: '丢弃此贮藏？',
                          message: (
                            <>
                              <p>Permanently remove <code>{s.ref}</code>.</p>
                              <p><strong>此操作无法撤销。</strong></p>
                            </>
                          ),
                          confirmLabel: 'Drop',
                          destructive: true,
                        },
                        () => writeOps.stashDrop(s.index),
                        'Drop stash',
                      )
                    }
                    aria-label="丢弃贮藏"
                  >丢弃</button>
                </Tooltip>
              </div>
            </div>
          )
        })}
      </div>
    </AnimatedDetails>
  )
}

// ── Recent commits ────────────────────────────────────────────────────

interface CommitListProps {
  cwd: string | undefined
  /** Hash of the one commit whose accordion is open, or null. */
  expandedCommit: string | null
  onToggleCommit: (hash: string) => void
  /** GitPanel-owned hash → commit-detail cache (survives collapse). */
  commitFileCache: Map<string, GitCommitResponse>
  /** Path of the keyboard-selected commit file row, or null. */
  selectedPath: string | null
  onSelectFile: (path: string) => void
}

function CommitList({
  cwd,
  expandedCommit,
  onToggleCommit,
  commitFileCache,
  selectedPath,
  onSelectFile,
}: CommitListProps) {
  const { data: commits, loading, error } = useGitLog(cwd, 30, true)
  if (loading) return <div className="git-commits-empty">正在加载提交…</div>
  if (error) return <div className="git-commits-empty git-commits-error">{error}</div>
  // Without a cwd nothing can have loaded, so the same empty state covers it.
  if (!cwd || !commits || commits.length === 0) return <div className="git-commits-empty">暂无提交</div>
  return (
    <ul className="git-commits-list">
      {commits.map((c) => (
        <CommitRow
          key={c.hash}
          cwd={cwd}
          hash={c.hash}
          subject={c.subject}
          author={c.author}
          date={c.date}
          body={commitFileCache.get(c.hash)?.commit.body ?? ''}
          expanded={expandedCommit === c.hash}
          onToggle={() => onToggleCommit(c.hash)}
          cache={commitFileCache}
          selectedPath={expandedCommit === c.hash ? selectedPath : null}
          onSelectFile={onSelectFile}
        />
      ))}
    </ul>
  )
}

