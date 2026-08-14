import { Navigate, Route, Routes } from 'react-router-dom'

import LivePage from './pages/live/LivePage'
import ReportPage from './pages/report/ReportPage'

/**
 * Two routes, two owners.
 *
 * `/live` and `/report` are developed independently and share nothing but
 * `src/protocol/`. Neither directory may import from the other.
 */
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/live" replace />} />
      <Route path="/live" element={<LivePage />} />
      <Route path="/report" element={<ReportPage />} />
      <Route path="/report/:sessionId" element={<ReportPage />} />
      <Route path="*" element={<Navigate to="/live" replace />} />
    </Routes>
  )
}
