// Context Monitor Status: shows the context-monitor mod's usage in the VS Code
// status bar for the Claude chat in the focused tab. The mod writes
// <workspace>/.claude/context-monitor/sessions/<id>.json after each reply; this
// extension watches those files. No build step, no dependencies.
const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const os = require('os')

const USAGE_REL = path.join('.claude', 'context-monitor', 'usage.json')
const RING_HEX = { success: '#2f9e5b', warning: '#d49b12', error: '#d9473f' }
const POLL_MS = 5000
// A chat counts as just started below this many conversation tokens (past the
// setup it starts with); without a setup figure, below FRESH_CHAT_TOKENS in all.
const FRESH_CONVERSATION_TOKENS = 25000
const FRESH_CHAT_TOKENS = 70000
const isFreshChat = d =>
  typeof d.setupTokens === 'number' && d.setupTokens > 0
    ? d.tokens - d.setupTokens < FRESH_CONVERSATION_TOKENS
    : d.tokens < FRESH_CHAT_TOKENS

const withCommas = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const pad = n => String(n).padStart(2, '0')
const hhmm = ms => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Quarter-step pie glyph for the percent. */
const pie = pct => (pct < 12.5 ? '○' : pct < 37.5 ? '◔' : pct < 62.5 ? '◑' : pct < 87.5 ? '◕' : '●')

const toneOf = (pct, data) =>
  pct >= data.redAt ? 'error' : pct >= data.amberAt ? 'warning' : 'success'

/** The same ring the mod drew, as an SVG data URI for the hover. */
const ringUri = (pct, tone) => {
  const size = 72
  const stroke = 7
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const p = Math.max(0, Math.min(100, pct))
  const dash = (p / 100) * c
  const hex = RING_HEX[tone]
  const label = Math.round(Math.max(0, pct))
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="#8a8a8a" stroke-opacity="0.25" stroke-width="${stroke}"/>` +
    `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${hex}" stroke-width="${stroke}" ` +
    `stroke-linecap="round" stroke-dasharray="${dash.toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 ${size / 2} ${size / 2})"/>` +
    `<text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" font-family="Segoe UI, system-ui, sans-serif" ` +
    `font-size="${label >= 100 ? 16 : 18}" font-weight="700" fill="${hex}">${label}%</text></svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}

// ---- Which chat to show --------------------------------------------------------
// The mod writes one file per chat (sessions/<id>.json). A Claude tab's label is
// its chat title cut to 25 characters, so the focused tab is matched to a chat by
// title, read from the chat's transcript. Ambiguous or unmatched: the chat that
// did something most recently.
const SESSIONS_REL = path.join('.claude', 'context-monitor', 'sessions')
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_TAB = 'Claude Code'

const readJson = file => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** Every chat's latest reading across the workspace folders, newest first. */
const readSessions = () => {
  const all = []
  const now = Date.now()
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const root = folder.uri.fsPath
    const dir = path.join(root, SESSIONS_REL)
    let names = []
    try {
      names = fs.readdirSync(dir).filter(n => n.endsWith('.json'))
    } catch {
      /* no per-chat files yet */
    }
    for (const n of names) {
      const data = readJson(path.join(dir, n))
      if (data && data.version === 1 && data.sessionId && now - data.updatedAt < MAX_AGE_MS) {
        all.push({ data, folder: root })
      }
    }
    // An older mod wrote only usage.json: count it as one chat.
    const legacy = readJson(path.join(root, USAGE_REL))
    if (legacy && legacy.version === 1 && legacy.sessionId && !all.some(s => s.data.sessionId === legacy.sessionId)) {
      all.push({ data: legacy, folder: root })
    }
  }
  return all.sort((a, b) => b.data.updatedAt - a.data.updatedAt)
}

// Titles per chat, cached by the transcript's mtime.
const titleCache = new Map() // sessionId -> { file, mtimeMs, titles: string[] }

const findTranscript = sessionId => {
  try {
    for (const d of fs.readdirSync(PROJECTS_DIR)) {
      const f = path.join(PROJECTS_DIR, d, `${sessionId}.jsonl`)
      if (fs.existsSync(f)) return f
    }
  } catch {
    /* no projects folder */
  }
  return null
}

const readSlice = (file, start, length) => {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(length)
    const n = fs.readSync(fd, buf, 0, length, start)
    return buf.subarray(0, n).toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

/** The names a chat's tab may carry: its custom title, AI title, first prompt. */
const titlesOf = sessionId => {
  const cached = titleCache.get(sessionId)
  const file = cached?.file ?? findTranscript(sessionId)
  if (file === null) return []
  let st
  try {
    st = fs.statSync(file)
  } catch {
    return []
  }
  if (cached && cached.mtimeMs === st.mtimeMs) return cached.titles
  const titles = []
  try {
    const tail = readSlice(file, Math.max(0, st.size - 512 * 1024), Math.min(st.size, 512 * 1024))
    const lastOf = re => {
      let m
      let found
      while ((m = re.exec(tail)) !== null) found = m[1]
      return found
    }
    const custom = lastOf(/"type":"custom-title","customTitle":"((?:[^"\\]|\\.)*)"/g)
    const ai = lastOf(/"type":"ai-title","aiTitle":"((?:[^"\\]|\\.)*)"/g)
    const head = readSlice(file, 0, Math.min(st.size, 256 * 1024))
    const first = /"lastPrompt":"((?:[^"\\]|\\.)*)"/.exec(head)
    for (const t of [custom, ai, first?.[1]]) {
      if (t) titles.push(JSON.parse(`"${t}"`))
    }
  } catch {
    /* unreadable: no titles */
  }
  titleCache.set(sessionId, { file, mtimeMs: st.mtimeMs, titles })
  return titles
}

const squash = s => s.replace(/\s+/g, ' ').trim()
/** As Claude Code cuts a title for its tab. */
const tabLabelOf = title => (title.length > 25 ? title.substring(0, 24) + '…' : title)
const labelMatches = (label, title) => {
  const a = squash(label)
  const b = squash(tabLabelOf(title))
  if (a === '' || b === '') return false
  if (a === b) return true
  return a.endsWith('…') && squash(title).startsWith(a.slice(0, -1))
}

/** The focused Claude tab's label, or undefined when a Claude tab isn't focused. */
const focusedClaudeLabel = () => {
  const tab = vscode.window.tabGroups.activeTabGroup?.activeTab
  if (!tab || !(tab.input instanceof vscode.TabInputWebview)) return undefined
  return tab.input.viewType.includes('claudeVSCodePanel') ? tab.label : undefined
}

/**
 * The chat to show and why: `tab` (matched the focused tab), `recent` (the last
 * active chat), or `sticky` (the chat shown before, while a file has focus).
 */
const pickSession = (sessions, previousId) => {
  if (sessions.length === 0) return null
  const label = focusedClaudeLabel()
  if (label === undefined) {
    const prev = sessions.find(s => s.data.sessionId === previousId)
    return prev ? { ...prev, how: 'sticky' } : { ...sessions[0], how: 'recent' }
  }
  const matches =
    label === DEFAULT_TAB
      ? sessions.filter(s => titlesOf(s.data.sessionId).length === 0)
      : sessions.filter(s => titlesOf(s.data.sessionId).some(t => labelMatches(label, t)))
  if (matches.length > 0) return { ...matches[0], how: matches.length === 1 ? 'tab' : 'recent', label }
  return { ...sessions[0], how: 'recent', label }
}

function activate(context) {
  const item = vscode.window.createStatusBarItem('contextMonitorStatus', vscode.StatusBarAlignment.Right, 100)
  item.name = 'Claude Context'
  item.command = 'contextMonitorStatus.openHandoff'
  context.subscriptions.push(item)

  let last = null
  let lastRaw = ''

  // ---- Nudges: a warning near the limit, an offer after a handoff -----------
  const config = () => vscode.workspace.getConfiguration('contextMonitorStatus')
  const remembered = key => new Set(context.workspaceState.get(key, []))
  const remember = (key, value) => {
    const all = [...remembered(key), value].slice(-50)
    void context.workspaceState.update(key, all)
  }

  const startNewChat = async () => {
    try {
      // The Claude Code extension's "Open in New Tab": (sessionId, initialPrompt).
      await vscode.commands.executeCommand('claude-vscode.editor.open', undefined, 'continue')
    } catch {
      await vscode.commands.executeCommand('claude-vscode.newConversation')
      vscode.window.showInformationMessage("New chat opened: type 'continue' to pick up from the handoff.")
    }
  }

  const nudge = d => {
    const h = d.handoff || { state: 'idle' }
    const warnAt = Number(config().get('warnAtTokens', 100000))
    if (
      warnAt > 0 &&
      d.sessionId &&
      d.tokens >= warnAt &&
      h.state !== 'running' &&
      h.state !== 'saved' &&
      !remembered('warned').has(d.sessionId)
    ) {
      remember('warned', d.sessionId)
      void vscode.window
        .showWarningMessage(
          `Claude context at ${withCommas(d.tokens)} tokens (${Math.round(d.percentOfThreshold)}% of the handoff point). Create a handoff?`,
          'Create handoff',
          'Dismiss',
        )
        .then(pick => {
          if (pick === 'Create handoff') void vscode.commands.executeCommand('contextMonitorStatus.createHandoff', d.sessionId)
        })
    }
    const fresh = h.state === 'saved' && Date.now() - h.at < 10 * 60 * 1000
    if (fresh && config().get('offerNewChat', true) && !remembered('offered').has(String(h.at))) {
      remember('offered', String(h.at))
      void vscode.window
        .showInformationMessage('Handoff saved. Start a new chat and continue?', 'Start new chat', 'Not now')
        .then(pick => {
          if (pick === 'Start new chat') {
            // That chat opens with 'continue' already typed: no need to offer it again.
            if (d.latestHandoff) remember('handoffOffered', String(d.latestHandoff.savedAt))
            void startNewChat()
          }
        })
    }

    // The mod's prompt.compose hook (which told a new chat about the handoff) can
    // be skipped by another plugin, so tell the person instead: once per handoff,
    // in a fresh chat, for a handoff from the last 24 hours.
    const lh = d.latestHandoff
    if (
      lh &&
      h.state === 'idle' &&
      isFreshChat(d) &&
      Date.now() - lh.savedAt < 24 * 60 * 60 * 1000 &&
      config().get('offerNewChat', true) &&
      !remembered('handoffOffered').has(String(lh.savedAt))
    ) {
      remember('handoffOffered', String(lh.savedAt))
      void vscode.window
        .showInformationMessage(
          `A handoff from ${hhmm(lh.savedAt)} is available. Type 'continue' in the new chat to pick it up.`,
          'Open handoff',
          'Dismiss',
        )
        .then(pick => {
          if (pick === 'Open handoff') void vscode.commands.executeCommand('contextMonitorStatus.openHandoff')
        })
    }
  }

  const chatName = found => {
    const titles = titlesOf(found.data.sessionId)
    return titles[0] ?? found.label ?? 'new chat'
  }
  const howText = found =>
    found.how === 'tab'
      ? 'the focused tab'
      : found.how === 'sticky'
        ? 'the last chat shown'
        : found.label === undefined
          ? 'the last active chat'
          : 'the last active chat (no single chat matched this tab)'

  const render = () => {
    const sessions = readSessions()
    // Nudges for every chat active in the last 10 minutes, shown or not.
    for (const s of sessions) if (Date.now() - s.data.updatedAt < 10 * 60 * 1000 && s.data.tokens !== null) nudge(s.data)

    const found = pickSession(sessions, last?.data.sessionId)
    const raw = found === null ? '' : JSON.stringify([found.data, found.how, found.label])
    if (raw === lastRaw && last !== null) return
    lastRaw = raw
    last = found

    if (found === null || found.data.tokens === null) {
      item.text = '○ —'
      item.color = undefined
      item.backgroundColor = undefined
      item.tooltip =
        found === null
          ? 'Claude context: no chat has replied yet'
          : `Claude context for "${chatName(found)}": waiting for its first reply`
      item.show()
      return
    }

    const d = found.data
    const pct = d.percentOfThreshold
    const tone = toneOf(pct, d)
    item.text = `${pie(pct)} ${Math.round(pct)}%`
    item.color = tone === 'success' ? RING_HEX.success : undefined
    item.backgroundColor =
      tone === 'error'
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : tone === 'warning'
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined

    const md = new vscode.MarkdownString(undefined, true)
    md.supportHtml = true
    md.appendMarkdown(`![ring](${ringUri(pct, tone)})\n\n`)
    md.appendMarkdown(`**Chat:** ${chatName(found).replace(/[\\`*_[\]<>]/g, '')}  \n`)
    md.appendMarkdown(`**${withCommas(d.tokens)} / ${withCommas(d.threshold)}** tokens until handoff  \n`)
    if (d.setupTokens > 0) md.appendMarkdown(`${withCommas(d.setupTokens)} setup at chat start (not counted in the %)  \n`)
    if (d.window) md.appendMarkdown(`${d.percentOfWindow.toFixed(1)}% of ${withCommas(d.window)} context window  \n`)
    const h = d.handoff || { state: 'idle' }
    if (h.state === 'running') md.appendMarkdown(`Creating handoff…  \n`)
    else if (h.state === 'saved') md.appendMarkdown(`✓ Handoff saved ${hhmm(h.at)}: start a new chat and say 'continue'  \n`)
    else if (h.state === 'failed') md.appendMarkdown(`Handoff failed: ${h.reason}  \n`)
    else if (d.latestHandoff) {
      md.appendMarkdown(`Latest handoff: ${new Date(d.latestHandoff.savedAt).toLocaleString()}  \n`)
      if (Date.now() - d.latestHandoff.savedAt < 24 * 60 * 60 * 1000) {
        md.appendMarkdown(`In a new chat, type 'continue' to pick it up  \n`)
      }
    }
    md.isTrusted = { enabledCommands: ['contextMonitorStatus.createHandoff'] }
    if (h.state !== 'running') {
      md.appendMarkdown(
        `\n[$(save) Create handoff](command:contextMonitorStatus.createHandoff "Write a handoff note for this chat now")\n`,
      )
    }
    md.appendMarkdown(`\n_Showing ${howText(found)} · updated ${hhmm(d.updatedAt)} · click to open latest.md_`)
    item.tooltip = md
    item.show()
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('contextMonitorStatus.refresh', () => {
      lastRaw = ''
      render()
    }),
    // Asks the mod for a handoff: it polls request.json and acts when the
    // session id matches its own. Default: the chat shown.
    vscode.commands.registerCommand('contextMonitorStatus.createHandoff', sessionId => {
      const target =
        typeof sessionId === 'string' ? readSessions().find(s => s.data.sessionId === sessionId) ?? null : last
      if (target === null || !target.data.sessionId) {
        vscode.window.showInformationMessage('No Claude chat to hand off yet.')
        return
      }
      const file = path.join(target.folder, '.claude', 'context-monitor', 'request.json')
      try {
        fs.writeFileSync(
          file,
          JSON.stringify({ action: 'handoff', sessionId: target.data.sessionId, requestedAt: Date.now() }, null, 2) + '\n',
        )
        item.text = '$(sync~spin) handoff'
        vscode.window.setStatusBarMessage('Context Monitor: handoff requested…', 4000)
      } catch (err) {
        vscode.window.showErrorMessage(`Could not request a handoff: ${err.message}`)
      }
    }),
    vscode.commands.registerCommand('contextMonitorStatus.openHandoff', async () => {
      const folder = last?.folder ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      const rel = last?.data.latestHandoff?.path ?? '.claude/handoffs/latest.md'
      const file = folder === undefined ? rel : path.resolve(folder, rel)
      if (!fs.existsSync(file)) {
        vscode.window.showInformationMessage('No handoff yet.')
        return
      }
      await vscode.window.showTextDocument(vscode.Uri.file(file))
    }),
  )

  // Watch the file; poll as a backstop, since .claude may be excluded from watching.
  const watcher = vscode.workspace.createFileSystemWatcher('**/.claude/context-monitor/**/*.json')
  watcher.onDidChange(render)
  watcher.onDidCreate(render)
  watcher.onDidDelete(render)
  context.subscriptions.push(watcher)
  // Switching tabs switches the chat shown.
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(render),
    vscode.window.tabGroups.onDidChangeTabGroups(render),
  )
  const timer = setInterval(render, POLL_MS)
  context.subscriptions.push({ dispose: () => clearInterval(timer) })
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(render))

  render()
}

function deactivate() {}

module.exports = { activate, deactivate }
