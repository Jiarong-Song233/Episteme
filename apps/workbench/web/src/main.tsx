import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Router } from 'wouter'
import { useHashLocation } from 'wouter/use-hash-location'
import { App } from './App.js'
import './style.css'

const root = document.getElementById('root')
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <Router hook={useHashLocation}>
        <App />
      </Router>
    </StrictMode>,
  )
}

// Installs as an app of its own window. The worker keeps only the page and its built files, never anyone's data.
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined)
  })
}
