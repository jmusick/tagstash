import { Info } from 'lucide-react'

// Hover hint inside a field action button. Hidden from assistive tech; a button that
// needs its hint read out passes an id and points aria-describedby at it.
export default function ActionInfo({ text, id, align = 'end' }) {
  return (
    <span className={`action-info-inline${align === 'start' ? ' action-info-inline--start' : ''}`} aria-hidden="true">
      <Info size={11} />
      <span id={id} className="action-info-tooltip" role="tooltip">{text}</span>
    </span>
  )
}
