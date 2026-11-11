import { Plugin } from "@opencode/plugin/tui"

// opencode-billing-widget — compact sidebar widget showing exact recorded
// dollar spend: current session, today, this week (Mon-start), this billing
// (calendar) month.
//
// Toggle:  /billing  (or command palette -> "Billing: toggle widget")
// Refresh: automatic on each finished turn + every 60s (palette -> "Billing: refresh")
// Data:    experimental.session.stats API (activity-accurate aggregates),
//          falling back to summing session.cost when the endpoint is unavailable.

const DAY = 24 * 60 * 60 * 1000

function windows() {
  const now = new Date()
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const mondayOffset = (now.getDay() + 6) % 7
  const startOfWeek = startOfDay - mondayOffset * DAY
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  return { to: now.getTime(), startOfDay, startOfWeek, startOfMonth }
}

function usd(n: number): string {
  if (!n) return "$0.00"
  if (n >= 100) return `$${n.toFixed(0)}`
  if (n >= 1) return `$${n.toFixed(2)}`
  return `$${n.toFixed(3)}`
}

export default Plugin.define({
  id: "opencode-billing-widget",
  async setup(context) {
    const [settings, updateSettings] = context.storage.store("settings", {
      initial: { enabled: true, collapsed: false },
    })
    const [stats, updateStats] = context.storage.memory("stats", {
      initial: { today: 0, week: 0, month: 0, ready: false },
    })

    const muted = () => context.theme.text?.muted ?? context.theme.text?.base
    const fg = () => context.theme.text?.base

    async function refresh() {
      const { to, startOfDay, startOfWeek, startOfMonth } = windows()
      try {
        const client = context.client as any
        // v2.2.0 exposes stats as client.session.stats; newer clients moved it
        // to client.experimental.session.stats. Promise clients return the
        // unwrapped SessionStatsInfo; accept a wrapped { data } shape too.
        const scope = client.experimental?.session?.stats ? client.experimental.session : client.session
        const stat = scope?.stats?.bind(scope)
        if (!stat) throw new Error("session stats unavailable")
        const unwrap = (r: any) => r?.cost ?? r?.data?.cost ?? 0
        const [day, week, month] = await Promise.all([
          stat({ from: startOfDay, to }),
          stat({ from: startOfWeek, to }),
          stat({ from: startOfMonth, to }),
        ])
        updateStats((draft) => {
          draft.today = unwrap(day)
          draft.week = unwrap(week)
          draft.month = unwrap(month)
          draft.ready = true
        })
      } catch {
        // Fallback: sum exact per-session costs by last activity time.
        try {
          const sessions = (context.data.session.list() ?? []) as any[]
          const sum = (from: number) =>
            sessions
              .filter((s) => (s?.time?.updated ?? s?.time?.created ?? 0) >= from)
              .reduce((acc, s) => acc + (s?.cost ?? 0), 0)
          updateStats((draft) => {
            draft.today = sum(startOfDay)
            draft.week = sum(startOfWeek)
            draft.month = sum(startOfMonth)
            draft.ready = true
          })
        } catch {
          // leave stale values
        }
      }
    }

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "billing.toggle",
          title: "Billing: toggle widget",
          group: "Billing",
          palette: true,
          slash: { name: "billing" },
          enabled: () => true,
          run: async () => {
            await updateSettings((draft) => {
              draft.enabled = !draft.enabled
            })
            context.ui.toast.show({
              message: `Billing widget ${settings.enabled ? "enabled" : "disabled"}`,
              variant: "info",
              duration: 1500,
            })
            if (settings.enabled) void refresh()
          },
        },
        {
          id: "billing.refresh",
          title: "Billing: refresh",
          group: "Billing",
          palette: true,
          enabled: () => settings.enabled,
          run: async () => {
            await refresh()
            context.ui.toast.show({ message: "Billing refreshed", variant: "success", duration: 1500 })
          },
        },
      ],
      bindings: [],
    }))

    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }: { sessionID: string }) => {
        if (!settings.enabled) return null
        const session = (context.data.session.get(sessionID) ?? {}) as any
        const sessionCost = (context.data.session.cost(sessionID) as any)?.total ?? session.cost ?? 0
        const monthName = new Date().toLocaleString("en", { month: "long" }).toLowerCase()
        const toggle = () =>
          void updateSettings((draft) => {
            draft.collapsed = !draft.collapsed
          })
        return (
          <box flexDirection="column" paddingTop={1}>
            <text fg={fg()} onMouseDown={toggle}>
              {settings.collapsed
                ? `► Billing  (${monthName} ${stats.ready ? usd(stats.month) : "…"})`
                : "▼ Billing"}
            </text>
            {!settings.collapsed && <text fg={muted()}>{`${usd(sessionCost)}   session`}</text>}
            {!settings.collapsed && <text fg={muted()}>{`${stats.ready ? usd(stats.today) : "…"}   today`}</text>}
            {!settings.collapsed && <text fg={muted()}>{`${stats.ready ? usd(stats.week) : "…"}   week`}</text>}
            {!settings.collapsed && (
              <text fg={muted()}>{`${stats.ready ? usd(stats.month) : "…"}   ${monthName}`}</text>
            )}
          </box>
        )
      },
    })

    const timer = setInterval(() => void refresh(), 60_000)
    const stop = context.data.on("session.execution.succeeded", () => void refresh())
    await refresh()

    return () => {
      clearInterval(timer)
      stop()
      unregister()
    }
  },
})
