import { useState } from 'react'
import { useDiagnostics } from '../hooks/useDiagnostics'
import { SettingsRow } from './SettingsRow'
import { Skeleton } from './Skeleton'
import { formatError } from '../utils/format-error'

/** Lines shown in the Diagnostics tab — full context for deep inspection. */
const STDERR_PANEL_LINES = 100

export function DiagnosticsPanel({ sessionId }: { sessionId: string }) {
  const { data, loading, error, refresh, setCliDebug } = useDiagnostics(sessionId)
  const [saving, setSaving] = useState(false)
  const [mutationError, setMutationError] = useState<string | null>(null)

  async function choose(value: boolean | null) {
    setSaving(true)
    setMutationError(null)
    try {
      await setCliDebug(value)
    } catch (e) {
      setMutationError(formatError(e))
    } finally {
      setSaving(false)
    }
  }

  if (loading && !data) {
    return (
      <div className="settings-stack">
        <div>
          <span className="settings-note">正在加载诊断…</span>
          <Skeleton rows={2} />
        </div>
      </div>
    )
  }
  if (error && !data) {
    return (
      <div className="settings-stack">
        <div className="settings-card-error">{error}</div>
      </div>
    )
  }

  const stderrLines = data?.stderrTail ?? []

  return (
    <div className="settings-stack">
      <div className="settings-tab-head">
        <h4>诊断</h4>
        <button className="btn btn-sm" onClick={() => void refresh()}>刷新</button>
      </div>

      <section className="settings-group">
          <div className="settings-group-head">
            <h4>CLI 调试</h4>
            <span className="settings-group-desc">来自支撑此会话的 CLI 子进程的详细日志。</span>
          </div>
          <SettingsRow
            stack
            title="CLI 调试日志"
            hint={<>Toggles debug output for this session. Applies on the next session start.</>}
          >
            <select
              className="select"
              value={data?.cliDebug.perSession === undefined ? '' : data.cliDebug.perSession ? 'on' : 'off'}
              onChange={(e) => {
                const v = e.target.value
                void choose(v === '' ? null : v === 'on')
              }}
              disabled={saving}>
              <option value="">Global ({data?.cliDebug.global ? 'on' : 'off'})</option>
              <option value="on">开</option>
              <option value="off">关闭</option>
            </select>
          </SettingsRow>
        </section>

        <section className="settings-group">
          <div className="settings-group-head">
            <h4>进程输出</h4>
            <span className="settings-group-desc">最近从 CLI 子进程捕获的实时 stderr。</span>
          </div>
          <SettingsRow stack title="stderr tail" hint={`${stderrLines.length} lines captured`}>
            <pre className="diag-stderr">
              {stderrLines.slice(-STDERR_PANEL_LINES).join('\n') || '(no stderr yet)'}
            </pre>
          </SettingsRow>
        </section>

        {data?.debugLog.exists && (
          <section className="settings-group">
            <div className="settings-group-head">
              <h4>调试日志</h4>
              <span className="settings-group-desc">已为此会话写入磁盘日志文件。</span>
            </div>
            <SettingsRow stack title="日志路径">
              <code className="settings-note">{data.debugLog.path}</code>
              <span className="settings-note"> ({data.debugLog.size} bytes)</span>
            </SettingsRow>
          </section>
        )}

      {mutationError && <div className="settings-card-error">{mutationError}</div>}
    </div>
  )
}
