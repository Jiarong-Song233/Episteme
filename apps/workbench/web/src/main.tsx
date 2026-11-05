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
