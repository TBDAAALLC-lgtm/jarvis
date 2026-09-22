import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { CrashGuard } from './ui/Crash.tsx'

// Deliberately no StrictMode: its double-invoked effects would open the
// microphone and arm the wake-word engine twice, and the second subscription
// steals the audio stream from the first.
//
// CrashGuard sits outside App on purpose. A boundary placed inside the tree
// it is meant to catch goes down with that tree, and the failure this exists
// for — a throw during the boot chain — takes the whole app with it.
createRoot(document.getElementById('root')!).render(
  <CrashGuard>
    <App />
  </CrashGuard>,
)
