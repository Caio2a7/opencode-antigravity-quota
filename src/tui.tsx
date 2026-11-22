import { homedir } from "node:os"
import { createSignal } from "solid-js"
import type { Plugin } from "@opencode/plugin/tui"
import { RefreshCommand } from "./command"
import { createCoordinator } from "./coordinator"
import { createLoader, readActiveAccountEmail } from "./loader"
import { parseOptions } from "./options"
import { createPoller, POST_TURN_MAX_AGE_MS } from "./poller"
import { buildRows } from "./rows"
import { defaultCacheDir, nodeFs } from "./shared-fs"
import { createSharedStore } from "./shared-state"
import { createRefreshCommand } from "./toast"
import type { QuotaSnapshot } from "./types"
import { QuotaView } from "./view"

const TICK_MS = 30_000
const ID = "opencode-antigravity-quota"

function initialSnapshot(cached: QuotaSnapshot | null, expectedEmail: string | null): QuotaSnapshot | null {
  if (!cached) return null
  if (expectedEmail === null) return cached
  return cached.accountEmail !== null && cached.accountEmail.toLowerCase() === expectedEmail.toLowerCase() ? cached : null
}

// Plain object instead of `Plugin.define()` (an identity function): published installs then need no runtime import
// of `@opencode/plugin`, which the host does not provide to packages under node_modules.
const plugin = {
  id: ID,
  setup(context) {
    const options = parseOptions(context.options)
    const store = createSharedStore({ dir: defaultCacheDir(process.env, homedir()), fs: nodeFs, now: Date.now })
    const expectedAccountEmail = () => readActiveAccountEmail(options.credentialsPath)
    const poller = createPoller({
      intervalMs: options.refreshIntervalMs,
      initial: initialSnapshot(store.read().snapshot, expectedAccountEmail()),
      load: createCoordinator({
        store,
        fetchOnce: createLoader(options.credentialsPath),
        intervalMs: options.refreshIntervalMs,
        now: Date.now,
        expectedAccountEmail,
      }),
    })
    const [state, setState] = createSignal(poller.getState())
    const [now, setNow] = createSignal(new Date())
    const unsubscribe = poller.subscribe((next) => setState(next))
    const ticker = setInterval(() => setNow(new Date()), TICK_MS)
    const rows = () => buildRows(state(), now(), options)
    const stopEvents = context.data.on("session.execution.succeeded", () => void poller.refresh(POST_TURN_MAX_AGE_MS))
    const forceRefresh = createRefreshCommand(poller, context.ui.toast)
    const removeSidebar = context.ui.slot({
      append: "sidebar.content",
      render: () => <QuotaView theme={context.theme} rows={rows} />,
    })
    const removeCommands = context.ui.slot({
      append: "app",
      render: () => <RefreshCommand keymap={context.keymap} id={ID} run={forceRefresh} />,
    })

    poller.start()
    return () => {
      removeSidebar()
      removeCommands()
      stopEvents()
      unsubscribe()
      clearInterval(ticker)
      poller.stop()
    }
  },
} satisfies Plugin.Definition

export default plugin
