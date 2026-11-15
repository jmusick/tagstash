import { useEffect, useState } from 'react'
import { billingAPI } from '../api/api'

const PLAN_LABELS = { monthly: 'Monthly', annual: 'Annual' }

export default function LibraryPlanMeter({ count, limit, onError }) {
  const [expandedOverride, setExpandedOverride] = useState(null)
  const [plans, setPlans] = useState(null)
  const [plansFailed, setPlansFailed] = useState(false)
  const [selectedPlan, setSelectedPlan] = useState('monthly')
  const [startingUpgrade, setStartingUpgrade] = useState(false)
  const expanded = expandedOverride ?? count >= limit * 0.8
  const availablePlans = (plans || []).filter((plan) => plan.available && PLAN_LABELS[plan.id])
  const planId = availablePlans.some((plan) => plan.id === selectedPlan)
    ? selectedPlan : availablePlans[0]?.id

  useEffect(() => {
    let cancelled = false
    billingAPI.getPlans().then((response) => {
      if (!cancelled) setPlans(response.data.plans || [])
    }).catch(() => {
      if (!cancelled) setPlansFailed(true)
    })
    return () => { cancelled = true }
  }, [])

  const startUpgrade = async () => {
    if (!planId || startingUpgrade) return
    setStartingUpgrade(true)
    try {
      const response = await billingAPI.createCheckoutSession(planId)
      if (!response?.data?.url) throw new Error('Missing checkout URL')
      window.location.assign(response.data.url)
    } catch (error) {
      onError(error?.response?.data?.error || 'Failed to start checkout. Please try again.')
      setStartingUpgrade(false)
    }
  }

  return (
    <section className="membership-summary" aria-label="Free plan usage">
      <button type="button" className="membership-usage-toggle"
        aria-expanded={expanded} aria-controls="library-plan-details"
        onClick={() => setExpandedOverride(!expanded)}>
        <span>Free · {count} / {limit}<span className="sr-only"> bookmarks used</span></span>
        <span className="usage-meter" aria-hidden="true">
          <span className="usage-meter-bar" style={{ width: `${Math.min(100, count / limit * 100)}%` }} />
        </span>
        <span className="membership-details-label">{expanded ? 'Hide details' : 'Details'}</span>
      </button>
      <div id="library-plan-details" className="membership-plan-details" hidden={!expanded}>
        <p className={count >= limit ? 'usage-limit-warning' : 'usage-limit-description'}>
          {count >= limit
            ? `You reached the free limit of ${limit} bookmarks. Move a bookmark to Trash to make room for another. You can still browse and edit your library.`
            : `The free plan includes ${limit} bookmarks. Bookmarks in Trash do not count toward the limit.`}
        </p>
        {availablePlans.length > 0 ? (
          <div className="membership-summary-actions">
            <span>Pro includes unlimited bookmarks.</span>
            <div className="upgrade-plan-toggle" role="group" aria-label="Choose billing plan">
              {availablePlans.map((plan) => (
                <button key={plan.id} type="button"
                  className={`upgrade-plan-btn ${planId === plan.id ? 'active' : ''}`}
                  aria-pressed={planId === plan.id} onClick={() => setSelectedPlan(plan.id)}
                  disabled={startingUpgrade}>
                  {PLAN_LABELS[plan.id]}
                </button>
              ))}
            </div>
            <button type="button" className="upgrade-placeholder-link"
              onClick={startUpgrade} disabled={startingUpgrade}>
              {startingUpgrade ? 'Opening checkout...' : `Upgrade (${PLAN_LABELS[planId]})`}
            </button>
          </div>
        ) : (
          <p className="usage-limit-description">
            {plansFailed ? 'Could not load paid plans. Try again from Settings → Billing.'
              : plans === null ? 'Checking paid plan availability…'
                : 'Paid plans are not available on this instance.'}
          </p>
        )}
      </div>
    </section>
  )
}
