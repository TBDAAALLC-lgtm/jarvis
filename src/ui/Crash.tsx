import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Show the crash instead of a black rectangle.
 *
 * React unmounts the entire tree when a render throws. Everything goes with
 * it: the reactor, the transcript, the status line, and every keyboard
 * handler — so the diagnostics panel on D stops answering too, at exactly the
 * moment someone would press it. What is left is a dark page that looks like
 * a hung boot, and the one piece of information that would explain it sits in
 * a console nobody has open.
 *
 * Same principle as the provider tiles and the auth check: a failure the user
 * can read is worth more than a tidy screen. It also catches what React
 * cannot — the boot sequence is an async chain, and a rejection inside it
 * would otherwise vanish without touching the UI at all.
 */

type State = { error: Error | null; where: string }

export class CrashGuard extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, where: '' }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[jarvis] render crashed', error, info.componentStack)
    this.setState({ where: info.componentStack?.trim().split('\n')[0] ?? '' })
  }

  componentDidMount() {
    window.addEventListener('unhandledrejection', this.onRejection)
    window.addEventListener('error', this.onError)
  }

  componentWillUnmount() {
    window.removeEventListener('unhandledrejection', this.onRejection)
    window.removeEventListener('error', this.onError)
  }

  onRejection = (e: PromiseRejectionEvent) => {
    if (this.state.error) return
    const r = e.reason
    this.setState({
      error: r instanceof Error ? r : new Error(String(r)),
      where: 'unhandled promise rejection',
    })
  }

  onError = (e: ErrorEvent) => {
    if (this.state.error) return
    this.setState({
      error: e.error instanceof Error ? e.error : new Error(e.message),
      where: `${e.filename ?? ''}:${e.lineno ?? ''}`,
    })
  }

  render() {
    const { error, where } = this.state
    if (!error) return this.props.children

    return (
      <div className="crash">
        <div className="crash-title">JARVIS STOPPED</div>
        <div className="crash-msg">{error.message || String(error)}</div>
        {where && <div className="crash-where">{where}</div>}
        {error.stack && <pre className="crash-stack">{error.stack}</pre>}
        <button
          className="crash-btn"
          type="button"
          onClick={() => window.location.reload()}
        >
          RELOAD
        </button>
      </div>
    )
  }
}
