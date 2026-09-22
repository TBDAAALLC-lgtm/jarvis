import { Component, type ReactNode } from 'react'

/**
 * Bloom is not worth the whole application.
 *
 * EffectComposer.addPass reads `alpha` off the renderer's context attributes.
 * When the WebGL context is missing or has been lost, getContextAttributes()
 * returns null and the read throws:
 *
 *   TypeError: Cannot read properties of null (reading 'alpha')
 *     at EffectComposer.addPass (postprocessing.js)
 *
 * That throw happens during commit, so without a boundary it unmounts the
 * whole React tree -- reactor, transcript, status line, and every keyboard
 * handler, including the diagnostics panel someone would press to find out
 * why. What is left is a black page indistinguishable from a hung boot.
 *
 * It is intermittent, because context creation depends on the GPU process,
 * the driver, and whatever else is holding contexts open at that moment. The
 * same build renders on one machine and blanks on another, and on the one it
 * blanks on, it blanks only sometimes.
 *
 * So: catch it here and render the scene without post-processing. The picture
 * loses its glow and keeps everything else. A dimmer reactor beats no
 * interface, and unlike the crash it says what happened.
 */

type State = { failed: boolean }

export class EffectsGuard extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(error: Error) {
    console.warn(
      '[morpheus] post-processing failed to start, continuing without it. ' +
        'The reactor will render without bloom. ' +
        (error?.message ?? ''),
    )
  }

  render() {
    return this.state.failed ? null : this.props.children
  }
}
