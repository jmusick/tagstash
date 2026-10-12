import { useEffect, useRef, useState } from 'react'
import './FeatureAnimation.css'

export default function FeatureAnimation({ clips }) {
  const [selected, setSelected] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [visible, setVisible] = useState(false)
  const [failed, setFailed] = useState(false)
  const videoRef = useRef(null)
  const clip = clips[selected]

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setPlaying(!preference.matches)
    update()
    preference.addEventListener('change', update)
    return () => preference.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      setVisible(entry.isIntersecting)
      if (entry.isIntersecting) setLoaded(true)
    }, { threshold: 0.15 })
    observer.observe(videoRef.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const video = videoRef.current
    let current = true
    if (loaded && visible && playing) video.play().catch(error => {
      if (current && error.name !== 'AbortError') setPlaying(false)
    })
    else video.pause()
    return () => { current = false }
  }, [loaded, visible, playing, selected])

  return (
    <figure className="feature-animation">
      <div className="feature-animation-choices" role="group" aria-label="Choose a feature demonstration">
        {clips.map((option, index) => (
          <button type="button" key={option.id} aria-pressed={selected === index} onClick={() => { setSelected(index); setFailed(false) }}>{option.title}</button>
        ))}
      </div>
      <video
        ref={videoRef}
        src={loaded ? `/feature-demos/${clip.id}.mp4` : undefined}
        poster={`/feature-demos/${clip.id}.jpg`}
        muted loop playsInline preload="none"
        width="1120" height="704"
        aria-label={`${clip.title}: ${clip.description}`}
        onError={() => setFailed(true)}
      />
      <figcaption>
        <div>
          <strong>{clip.title}</strong>
          <p>{clip.description}</p>
          {failed && <p role="status">This animation could not load. You can still read the walkthrough below.</p>}
        </div>
        <div className="feature-animation-actions">
          <button type="button" onClick={() => setPlaying(value => !value)} aria-label={`${playing ? 'Pause' : 'Play'} animation: ${clip.title.toLowerCase()}`}>{playing ? 'Pause animation' : 'Play animation'}</button>
          <a href={`/feature-demos/${clip.id}.mp4`} target="_blank" rel="noopener noreferrer">View larger</a>
        </div>
      </figcaption>
      <details>
        <summary>Read the walkthroughs</summary>
        {clips.map(walkthrough => (
          <section key={walkthrough.id}>
            <h3>{walkthrough.title}</h3>
            <p>{walkthrough.description}</p>
            <ol>{walkthrough.steps.map(step => <li key={step}>{step}</li>)}</ol>
          </section>
        ))}
      </details>
    </figure>
  )
}
