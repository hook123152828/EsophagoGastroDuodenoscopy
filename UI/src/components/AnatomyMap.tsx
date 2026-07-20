import { modeOf, type GnsMode } from '../types'
import { MODE_COLOR } from '../lib/display'
import { REGION_OF_CLASS, type Region } from '../lib/anatomy'

interface Station {
  id: Region
  label: string
  cx: number
  cy: number
  lx: number
  ly: number
  anchor: 'start' | 'end'
}

// Ordered along the endoscope's path, top of the tract to the duodenum.
const STATIONS: Station[] = [
  { id: 'esophagus', label: '食道', cx: 98, cy: 30, lx: 116, ly: 31, anchor: 'start' },
  { id: 'proximal', label: '賁門 / 胃底', cx: 72, cy: 86, lx: 54, ly: 87, anchor: 'end' },
  { id: 'body', label: '胃體', cx: 88, cy: 146, lx: 50, ly: 150, anchor: 'end' },
  { id: 'angle', label: '胃角', cx: 118, cy: 196, lx: 108, ly: 214, anchor: 'end' },
  { id: 'antrum', label: '胃竇', cx: 156, cy: 168, lx: 176, ly: 176, anchor: 'start' },
  { id: 'duodenum', label: '十二指腸', cx: 190, cy: 122, lx: 206, ly: 120, anchor: 'start' },
]

interface Props {
  activeClass: string | null
  uncertain: boolean
}

export function AnatomyMap({ activeClass, uncertain }: Props) {
  const activeRegion = !uncertain && activeClass ? REGION_OF_CLASS[activeClass] ?? null : null
  const mode: GnsMode = activeClass ? modeOf(activeClass) : 'neutral'
  const accent = MODE_COLOR[mode]

  return (
    <svg viewBox="0 0 240 250" className="h-full w-full" role="img" aria-label="上消化道部位圖">
      {/* The anatomy is drawn for a left-facing stomach; mirror the geometry
          horizontally (x → 240 − x) so it matches the endoscopic orientation.
          Text is rendered outside this group so labels stay upright. */}
      <g transform="matrix(-1 0 0 1 240 0)">
        {/* Stomach silhouette — soft context behind the stations. */}
        <path
          d="M96 56 C70 52 50 70 48 100 C46 132 52 168 82 190 C110 210 150 204 168 180 C180 164 178 150 166 148 C154 150 146 154 136 162 C126 152 122 128 118 104 C114 82 108 66 96 56 Z"
          fill="var(--sunken)"
          stroke="var(--line)"
          strokeWidth="1.5"
        />
        {/* Esophagus tube */}
        <path d="M92 14 L92 58 M104 14 L104 58" stroke="var(--line)" strokeWidth="1.5" fill="none" />
        {/* Duodenal loop */}
        <path
          d="M166 148 C192 142 206 162 200 184 C195 202 176 204 164 194"
          fill="none"
          stroke="var(--line)"
          strokeWidth="1.5"
        />

        {/* Endoscope route through the stations */}
        <path
          d="M98 30 L72 86 L88 146 L118 196 L156 168 L190 122"
          fill="none"
          stroke="var(--line)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray="2 5"
        />

        {STATIONS.map((s) => {
          const active = s.id === activeRegion
          return (
            <g key={s.id}>
              {active && (
                <circle cx={s.cx} cy={s.cy} r={14} fill={accent} opacity={0.16} className="animate-station" />
              )}
              <circle
                cx={s.cx}
                cy={s.cy}
                r={active ? 7 : 4.5}
                fill={active ? accent : 'var(--surface)'}
                stroke={active ? accent : 'var(--ink-faint)'}
                strokeWidth={active ? 0 : 1.5}
                style={{ transition: 'all .3s ease' }}
              />
            </g>
          )
        })}
      </g>

      {/* Labels, upright — mirror the x anchor and flip start/end so each sits
          beside its (now mirrored) station. */}
      {STATIONS.map((s) => {
        const active = s.id === activeRegion
        return (
          <text
            key={s.id}
            x={240 - s.lx}
            y={s.ly}
            textAnchor={s.anchor === 'start' ? 'end' : 'start'}
            dominantBaseline="middle"
            fontSize="11"
            fontWeight={active ? 600 : 400}
            fill={active ? 'var(--ink)' : 'var(--ink-faint)'}
            style={{ transition: 'all .3s ease' }}
          >
            {s.label}
          </text>
        )
      })}
    </svg>
  )
}
