import type { Plugin } from "@opencode/plugin/tui"

interface Props {
  keymap: Plugin.Context["keymap"]
  id: string
  run: () => Promise<void>
}

/** Renders nothing; exists because keymap layers must be owned by a mounted component. */
export function RefreshCommand(props: Props) {
  props.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: `${props.id}.refresh`,
        title: "Refresh Antigravity quota",
        group: "Antigravity Quota",
        palette: true,
        slash: { name: "antigravity-quota", aliases: ["ag-quota"] },
        run: props.run,
      },
    ],
  }))
  return null
}
