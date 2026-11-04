// session-board's values in $.state: the contract `claude plugin validate` holds the mod to.

/** The name given with `/session-board name`; null shows the project's name. */
export type SessionName = string | null

declare module 'claude-code' {
  interface PluginState {
    'session-board': {
      name: SessionName
    }
  }
}
