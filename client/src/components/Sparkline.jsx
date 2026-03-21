/**
 * Minimal SVG sparkline — no axes, no labels, just the shape.
 * data: number[]  (e.g. cumulative net profit values)
 */
export default function Sparkline({ data, width = 96, height = 36, strokeWidth = 1.5 }) {
  if (!data || data.length < 2) {
    return <svg width={width} height={height} />
  }

  const min   = Math.min(...data)
  const max   = Math.max(...data)
  const range = max - min || 1
  const pad   = 2  // px padding inside SVG edges

  const x = i  => pad + (i / (data.length - 1)) * (width  - pad * 2)
  const y = v  => height - pad - ((v - min) / range) * (height - pad * 2)

  const points = data.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`)
  const pathD  = `M ${points.join(' L ')}`

  const finalVal = data[data.length - 1]
  const color    = finalVal > 0 ? '#34d399' : finalVal < 0 ? '#f87171' : '#6b7280'

  // Area fill under the line (down to the zero line or min, whichever is visible)
  const zeroY   = Math.min(height - pad, Math.max(pad, y(0)))
  const fillD   = `${pathD} L ${x(data.length - 1).toFixed(1)},${zeroY} L ${x(0).toFixed(1)},${zeroY} Z`

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="overflow-visible"
    >
      {/* Area fill */}
      <path
        d={fillD}
        fill={color}
        fillOpacity={0.08}
      />
      {/* Zero reference line */}
      <line
        x1={pad}
        y1={zeroY}
        x2={width - pad}
        y2={zeroY}
        stroke="#374151"
        strokeWidth={0.5}
        strokeDasharray="2 2"
      />
      {/* Main line */}
      <path
        d={pathD}
        stroke={color}
        strokeWidth={strokeWidth}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Final value dot */}
      <circle
        cx={x(data.length - 1).toFixed(1)}
        cy={y(finalVal).toFixed(1)}
        r={2}
        fill={color}
      />
    </svg>
  )
}
